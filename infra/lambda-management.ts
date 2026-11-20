/** CloudFormation actions to manage one named Lambda function and its settings. */
export const FUNCTION_MANAGEMENT_ACTIONS = [
  'lambda:CreateFunction', 'lambda:DeleteFunction', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration',
  'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration',
  'lambda:ListTags', 'lambda:TagResource', 'lambda:UntagResource',
  'lambda:GetFunctionConcurrency', 'lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency',
  'lambda:GetRuntimeManagementConfig', 'lambda:GetFunctionCodeSigningConfig',
  'lambda:GetPolicy', 'lambda:RemovePermission',
] as const;

/** CloudFormation actions to manage one named log group, without reading its events. */
export const LOG_GROUP_MANAGEMENT_ACTIONS = ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy',
  'logs:DeleteRetentionPolicy', 'logs:ListTagsForResource', 'logs:ListTagsLogGroup', 'logs:TagResource', 'logs:TagLogGroup'] as const;
