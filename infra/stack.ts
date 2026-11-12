import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { DeploymentConfig } from '../src/config.js';
import { CognitoAuth } from './cognito.js';

export class ObsidianStack extends Stack {
  constructor(scope: Construct, id: string, config: DeploymentConfig, props: StackProps = {}) {
    super(scope, id, { ...props, env: { account: config.account, region: config.region } });
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const api = new apigw.HttpApi(this, 'Api', { description: 'OAuth-protected private Obsidian MCP' });
    const auth = new CognitoAuth(this, 'Auth', config);
    const resource = `${api.apiEndpoint}/mcp`;
    const functionLogs = new logs.LogGroup(this, 'FunctionLogs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.RETAIN });
    const role = new iam.Role(this, 'ReaderRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    const bucketArn = `arn:${this.partition}:s3:::${config.bucket}`;
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'], resources: [bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${config.prefix}*`] } },
    }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`${bucketArn}/${config.prefix}*`] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [functionLogs.logGroupArn] }));
    if (config.kmsKeyArn) role.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'], resources: [config.kmsKeyArn],
      conditions: { StringEquals: { 'kms:ViaService': `s3.${config.region}.amazonaws.com` },
        StringLike: { 'kms:EncryptionContext:aws:s3:arn': [bucketArn, `${bucketArn}/${config.prefix}*`] } },
    }));
    const fn = new NodejsFunction(this, 'McpFunction', {
      entry: path.join(root, 'src/handler.ts'), handler: 'handler', runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64, timeout: Duration.seconds(25), memorySize: 256,
      reservedConcurrentExecutions: 5, role, logGroup: functionLogs,
      depsLockFilePath: path.join(root, 'package-lock.json'), projectRoot: root,
      bundling: { target: 'node22', format: OutputFormat.ESM, minify: true, sourceMap: false, externalModules: [],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
      environment: {
        AWS_ACCOUNT_ID: config.account, NOTES_REGION: config.region,
        NOTES_BUCKET: config.bucket, NOTES_PREFIX: config.prefix,
        MCP_RESOURCE: resource, OAUTH_CONFIG: JSON.stringify(auth.oauth),
        ALLOWED_ORIGINS: JSON.stringify(config.allowedOrigins),
      },
    });
    const integration = new HttpLambdaIntegration('LambdaIntegration', fn);
    api.addRoutes({ path: '/mcp', methods: [apigw.HttpMethod.ANY], integration });
    for (const route of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      api.addRoutes({ path: route, methods: [apigw.HttpMethod.GET], integration });
    }
    const accessLogs = new logs.LogGroup(this, 'AccessLogs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.RETAIN });
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 5, throttlingRateLimit: 2 };
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({ requestId: '$context.requestId', status: '$context.status', latency: '$context.responseLatency' }),
    };
    new CfnOutput(this, 'McpEndpoint', { value: resource });
    new CfnOutput(this, 'OAuthAudience', { value: resource });
    new CfnOutput(this, 'OAuthIssuer', { value: auth.oauth.issuer });
    new CfnOutput(this, 'OAuthClientId', { value: auth.oauth.clientId });
    new CfnOutput(this, 'OAuthScope', { value: auth.oauth.scope });
    new CfnOutput(this, 'FunctionLogGroup', { value: functionLogs.logGroupName });
  }
}
