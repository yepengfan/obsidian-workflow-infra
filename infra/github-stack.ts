import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface GitHubTrustConfig {
  account: string;
  region: string;
  repositorySubject: string;
  createProvider: boolean;
  bootstrapQualifier: string;
}

// Optional one-time setup, kept separate from the application reader role.
export class GitHubTrustStack extends Stack {
  constructor(scope: Construct, id: string, config: GitHubTrustConfig) {
    super(scope, id, { env: { account: config.account, region: config.region } });
    const provider = config.createProvider
      ? new iam.OpenIdConnectProvider(this, 'Provider', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'Provider', `arn:${this.partition}:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`);
    const principal = (environment: string) => new iam.FederatedPrincipal(provider.openIdConnectProviderArn, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `${config.repositorySubject}:environment:${environment}`,
      },
    }, 'sts:AssumeRoleWithWebIdentity');
    const plan = new iam.Role(this, 'PlanRole', { assumedBy: principal('production-plan'), maxSessionDuration: Duration.hours(1) });
    const deploy = new iam.Role(this, 'DeployRole', { assumedBy: principal('production'), maxSessionDuration: Duration.hours(1) });
    const stacks = ['ObsidianS3Mcp', 'CDKToolkit'].map((name) => `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/${name}/*`);
    for (const role of [plan, deploy]) {
      role.addToPolicy(new iam.PolicyStatement({ actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate', 'cloudformation:DescribeStackEvents', 'cloudformation:DescribeStackResources'], resources: stacks }));
      role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/${config.bootstrapQualifier}/version`] }));
    }
    deploy.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [
      `arn:${this.partition}:iam::${this.account}:role/cdk-${config.bootstrapQualifier}-deploy-role-${this.account}-${this.region}`,
      `arn:${this.partition}:iam::${this.account}:role/cdk-${config.bootstrapQualifier}-file-publishing-role-${this.account}-${this.region}`,
    ] }));
    new CfnOutput(this, 'PlanRoleArn', { value: plan.roleArn });
    new CfnOutput(this, 'DeployRoleArn', { value: deploy.roleArn });
  }
}
