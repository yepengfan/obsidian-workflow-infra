import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnWorkGroup } from 'aws-cdk-lib/aws-athena';
import { CfnCatalog } from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { METADATA_WORKGROUP } from '../src/metadata-search.js';

export function addMetadataSearch(scope: Construct) {
  const stack = Stack.of(scope);
  // Regional integration is native IaC. If it already exists, import it before
  // applying this change; never recreate an existing Lake Formation setup.
  const catalog = new CfnCatalog(scope, 'S3TablesCatalog', {
    name: 's3tablescatalog',
    federatedCatalog: { identifier: `arn:${stack.partition}:s3tables:${stack.region}:${stack.account}:bucket/*`, connectionName: 'aws:s3tables' },
    createDatabaseDefaultPermissions: [{ principal: { dataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' }, permissions: ['ALL'] }],
    createTableDefaultPermissions: [{ principal: { dataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' }, permissions: ['ALL'] }],
    allowFullTableExternalDataAccess: 'True',
  });
  catalog.overrideLogicalId('S3TablesCatalog');
  catalog.applyRemovalPolicy(RemovalPolicy.RETAIN);
  const workgroup = new CfnWorkGroup(scope, 'MetadataWorkgroup', {
    name: METADATA_WORKGROUP, recursiveDeleteOption: true,
    workGroupConfiguration: { enforceWorkGroupConfiguration: true, engineVersion: { selectedEngineVersion: 'Athena engine version 3' },
      bytesScannedCutoffPerQuery: 256 * 1024 * 1024, publishCloudWatchMetricsEnabled: true,
      managedQueryResultsConfiguration: { enabled: true } },
  });
  workgroup.overrideLogicalId('MetadataWorkgroup');
  return { catalog, workgroup };
}

/** Keep query permissions separate from note reads and practice writes. */
export function grantMetadataSearch(stack: Stack, vault: string, runtime: iam.Role, execution: iam.Role) {
  const arn = (service: string, resource: string) => `arn:${stack.partition}:${service}:${stack.region}:${stack.account}:${resource}`;
  const workgroup = arn('athena', `workgroup/${METADATA_WORKGROUP}`);
  const rootCatalog = arn('glue', 'catalog');
  const catalog = arn('glue', 'catalog/s3tablescatalog');
  const namespace = `b_${vault}`;
  const tableBucket = arn('s3tables', 'bucket/aws-s3');
  runtime.addToPolicy(new iam.PolicyStatement({ actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults'], resources: [workgroup] }));
  runtime.addToPolicy(new iam.PolicyStatement({ actions: ['athena:GetDataCatalog'], resources: [arn('athena', 'datacatalog/AwsDataCatalog'), arn('athena', 'datacatalog/s3tablescatalog/aws-s3')] }));
  runtime.addToPolicy(new iam.PolicyStatement({ actions: ['glue:GetCatalog', 'glue:GetDatabase', 'glue:GetTable'], resources: [rootCatalog, catalog,
    arn('glue', 'catalog/s3tablescatalog/aws-s3'), arn('glue', `database/s3tablescatalog/aws-s3/${namespace}`), arn('glue', `table/s3tablescatalog/aws-s3/${namespace}/inventory`)] }));
  runtime.addToPolicy(new iam.PolicyStatement({ actions: ['s3tables:GetTable', 's3tables:GetTableMetadataLocation', 's3tables:GetTableData'],
    resources: [`${tableBucket}/table/*`],
    conditions: { StringEquals: { 's3tables:namespace': namespace, 's3tables:tableName': 'inventory' } } }));
  runtime.addToPolicy(new iam.PolicyStatement({ actions: ['s3tables:GetTableBucket'], resources: [tableBucket] }));
  runtime.addToPolicy(new iam.PolicyStatement({ actions: ['s3tables:GetNamespace'], resources: [tableBucket],
    conditions: { StringEquals: { 's3tables:namespace': namespace } } }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['athena:CreateWorkGroup', 'athena:GetWorkGroup', 'athena:UpdateWorkGroup', 'athena:DeleteWorkGroup',
    'athena:TagResource', 'athena:UntagResource', 'athena:ListTagsForResource'], resources: [workgroup] }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['glue:CreateCatalog', 'glue:GetCatalog', 'glue:UpdateCatalog', 'glue:DeleteCatalog', 'glue:GetTags', 'glue:TagResource', 'glue:UntagResource'], resources: [rootCatalog, catalog] }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['glue:PassConnection'], resources: [arn('glue', 'connection/aws:s3tables')] }));
  // The regional federated catalog's Identifier is bucket/*, so its native
  // registration role needs the regional read prerequisites. This is NOT the
  // Lambda role: runtime reads above remain limited to the vault inventory.
  // https://docs.aws.amazon.com/glue/latest/dg/s3tables-catalog-prerequisites.html
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['glue:GetCatalog', 'glue:GetDatabase', 'glue:GetTable'],
    resources: [rootCatalog, catalog, arn('glue', 'catalog/s3tablescatalog/*'),
      arn('glue', 'database/s3tablescatalog/*/*'), arn('glue', 'table/s3tablescatalog/*/*/*')] }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['s3tables:GetTableBucket', 's3tables:GetNamespace'], resources: [arn('s3tables', 'bucket/*')] }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['s3tables:GetTable', 's3tables:GetTableMetadataLocation', 's3tables:GetTableData'], resources: [arn('s3tables', 'bucket/*/table/*')] }));
}

export function grantMetadataConfiguration(stack: Stack, vault: string, execution: iam.Role) {
  const tableBucket = `arn:${stack.partition}:s3tables:${stack.region}:${stack.account}:bucket/aws-s3`;
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['s3:CreateBucketMetadataTableConfiguration', 's3:DeleteBucketMetadataTableConfiguration',
    's3:UpdateBucketMetadataJournalTableConfiguration', 's3:UpdateBucketMetadataInventoryTableConfiguration'], resources: [`arn:${stack.partition}:s3:::${vault}`] }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['s3tables:CreateTableBucket', 's3tables:GetTableBucket', 's3tables:PutTableBucketPolicy'], resources: [tableBucket] }));
  // CreateNamespace does not supply the s3tables:namespace condition key.
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['s3tables:CreateNamespace'], resources: [tableBucket] }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['s3tables:CreateTable'], resources: [tableBucket],
    conditions: { StringEquals: { 's3tables:namespace': `b_${vault}` } } }));
  // CreateTable with encryption checks this dependent permission on the bucket
  // before a table exists. Existing-table encryption stays scoped below.
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['s3tables:PutTableEncryption'], resources: [tableBucket] }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['s3tables:GetTable', 's3tables:PutTablePolicy', 's3tables:PutTableEncryption'], resources: [`${tableBucket}/table/*`],
    conditions: { StringEquals: { 's3tables:namespace': `b_${vault}`, 's3tables:tableName': ['inventory', 'journal'] } } }));
}
