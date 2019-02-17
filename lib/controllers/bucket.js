"use strict";

const S3Error = require("../models/error");

exports.bucketExists = async function bucketExists(ctx, next) {
  const bucketName = ctx.params.bucket;
  const bucket = await ctx.app.store.getBucket(bucketName);
  if (!bucket) {
    ctx.logger.error('No bucket found for "%s"', bucketName);
    throw new S3Error("NoSuchBucket", "The specified bucket does not exist", {
      BucketName: bucketName
    });
  }
  ctx.bucket = bucket;
  if (next) await next();
};

/*
 * Operations on Buckets
 * The following methods correspond to operations you can perform on Amazon S3 buckets.
 * https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketOps.html
 */

exports.METHODS = [
  "acl",
  "analytics",
  "cors",
  "delete",
  "encryption",
  "inventory",
  "lifecycle",
  "metrics",
  "notification",
  "object-lock",
  "policy",
  "policyStatus",
  "publicAccessBlock",
  "replication",
  "requestPayment",
  "tagging",
  "uploads",
  "versions",
  "website"
];

/**
 * DELETE Bucket
 * Deletes the bucket named in the URI. All objects (including all object versions and delete
 * markers) in the bucket must be deleted before the bucket itself can be deleted.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketDELETE.html}
 */
exports.deleteBucket = async function deleteBucket(ctx) {
  try {
    await ctx.store.deleteBucket(ctx.params.bucket);
    ctx.status = 204;
  } catch (err) {
    throw new S3Error(
      "BucketNotEmpty",
      "The bucket your tried to delete is not empty",
      { BucketName: ctx.params.bucket }
    );
  }
};

/**
 * GET Bucket (List Objects) Version 1/2
 * This implementation of the GET operation returns some or all (up to 1,000) of the objects in a
 * bucket.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketGET.html}
 */
exports.getBucket = async function getBucket(ctx) {
  const options = {
    delimiter: ctx.query["delimiter"],
    marker: ctx.query["marker"],
    maxKeys: Math.min(1000, Number(ctx.query["max-keys"]) || Infinity),
    prefix: ctx.query["prefix"]
  };
  ctx.logger.info(
    'Fetched bucket "%s" with options %s',
    ctx.params.bucket,
    options
  );
  try {
    const results = await ctx.store.listObjects(ctx.params.bucket, options);
    ctx.logger.info(
      'Found %d objects for bucket "%s"',
      results.objects.length,
      ctx.params.bucket
    );
    ctx.body = {
      ListBucketResult: {
        "@": { xmlns: "http://doc.s3.amazonaws.com/2006-03-01/" },
        IsTruncated: results.isTruncated || false,
        Marker: options.marker || "",
        Name: ctx.params.bucket,
        Prefix: options.prefix || "",
        MaxKeys: options.maxKeys,
        CommonPrefixes: results.commonPrefixes.map(prefix => ({
          Prefix: prefix
        })),
        Contents: results.objects.map(object => ({
          Key: object.key,
          LastModified: object.lastModifiedDate.toISOString(),
          ETag: object.metadata["etag"],
          Size: object.size,
          StorageClass: "STANDARD",
          Owner: {
            ID: 123,
            DisplayName: "S3rver"
          }
        }))
      }
    };
  } catch (err) {
    ctx.logger.error(
      'Error listing objects in bucket "%s"',
      ctx.params.bucket,
      err
    );
    throw err;
  }
};

/**
 * PUT Bucket
 * This implementation of the PUT operation creates a new bucket. To create a bucket, you must
 * register with Amazon S3 and have a valid AWS Access Key ID to authenticate requests. Anonymous
 * requests are never allowed to create buckets. By creating the bucket, you become the bucket
 * owner.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketPUT.html}
 */
exports.putBucket = async function putBucket(ctx) {
  const bucketName = ctx.params.bucket;
  /**
   * Derived from http://docs.aws.amazon.com/AmazonS3/latest/dev/BucketRestrictions.html
   */
  if (!/^[a-z0-9]+(.?[-a-z0-9]+)*$/.test(bucketName)) {
    ctx.logger.error(
      'Error creating bucket "%s" because the name is invalid',
      bucketName
    );
    throw new S3Error(
      "InvalidBucketName",
      "Bucket names can contain lowercase letters, numbers, and hyphens. " +
        "Each label must start and end with a lowercase letter or a number."
    );
  }
  if (bucketName.length < 3 || 63 < bucketName.length) {
    ctx.logger.error(
      'Error creating bucket "%s" because the name is invalid',
      bucketName
    );
    throw new S3Error(
      "InvalidBucketName",
      "The bucket name must be between 3 and 63 characters."
    );
  }
  const bucket = await ctx.store.getBucket(bucketName);
  if (bucket) {
    ctx.logger.error(
      'Error creating bucket. Bucket "%s" already exists',
      bucketName
    );
    throw new S3Error(
      "BucketAlreadyExists",
      "The requested bucket already exists"
    );
  }
  await ctx.store.putBucket(bucketName);
  ctx.logger.info('Created new bucket "%s" successfully', bucketName);
  ctx.set("Location", "/" + bucketName);
  ctx.body = "";
};
