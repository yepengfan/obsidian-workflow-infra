import { loadGitHubConfig } from '../infra/github-config.js';
import { awsRegionSchema } from '../infra/storage-config.js';

const account = process.env.AWS_ACCOUNT_ID;
if (!account || !/^\d{12}$/u.test(account)) throw Error('Set the AWS_ACCOUNT_ID repository secret');
const region = awsRegionSchema.safeParse(process.env.AWS_REGION);
if (!region.success) throw Error('Set the AWS_REGION repository secret');

const github = loadGitHubConfig(region.data);
const roles = { plan: github.planRoleName, apply: github.deployRoleName, retention: github.codeRetentionRoleName };
const job = process.argv[2];
if (job !== 'plan' && job !== 'apply' && job !== 'retention') throw Error('Select plan, apply or retention');
const roleArn = (name: string) => `arn:aws:iam::${account}:role/${name}`;
console.log(`account=${account}`);
console.log(`region=${region.data}`);
console.log(`roleArn=${roleArn(roles[job])}`);
if (job === 'plan') {
  console.log(`storageRole=${roleArn(github.executionRoleName)}`);
  console.log(`mcpRole=${roleArn(github.mcpExecutionRoleName)}`);
}
