import { z } from 'zod';

export const STORAGE_STACK_NAME = 'ObsidianWorkflowStorage';

const bucketName = z.string().min(3).max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u)
  .refine((value) => !value.includes('..') && !/^\d+\.\d+\.\d+\.\d+$/u.test(value), 'Invalid S3 bucket name');

const bucketSchema = z.object({
  name: bucketName,
  // Unversioned means omit VersioningConfiguration, not set it to Suspended.
  versioning: z.enum(['unversioned', 'enabled', 'suspended']),
  noncurrentVersionRetentionDays: z.literal(90).optional(),
  encryption: z.object({
    algorithm: z.literal('AES256'),
    bucketKeyEnabled: z.boolean(),
    blockedEncryptionTypes: z.array(z.literal('SSE-C')).max(1),
  }).strict(),
  publicAccessBlock: z.object({
    blockPublicAcls: z.literal(true), ignorePublicAcls: z.literal(true),
    blockPublicPolicy: z.literal(true), restrictPublicBuckets: z.literal(true),
  }).strict(),
  objectOwnership: z.literal('BucketOwnerEnforced'),
}).strict().refine(settings => settings.noncurrentVersionRetentionDays === undefined || settings.versioning === 'enabled',
  'Noncurrent-version retention requires enabled versioning');

export const storageSchema = z.object({
  account: z.string().regex(/^\d{12}$/u),
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/u),
  retention: z.strictObject({
    unusedCodeDays: z.number().int().min(1).max(3650),
    incompleteMultipartUploadDays: z.number().int().min(1).max(365),
    logDays: z.literal(14),
    maxCodeVersionsPerRun: z.number().int().min(1).max(10000),
    maxCodeChangesPerRun: z.number().int().min(1).max(2000),
  }),
  buckets: z.object({ vault: bucketSchema, library: bucketSchema }).strict(),
}).strict().refine((value) => value.buckets.vault.name !== value.buckets.library.name, 'Bucket names must differ');

export type StorageConfig = z.infer<typeof storageSchema>;
