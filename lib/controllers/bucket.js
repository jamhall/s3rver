'use strict';

const crypto = require('crypto');

const { DUMMY_ACCOUNT } = require('../models/account');
const S3Error = require('../models/error');
const {
  S3CorsConfiguration,
  S3WebsiteConfiguration,
} = require('../models/config');
const { utf8BodyParser } = require('../utils');

function generateContinuationToken(bucket, keyName, region) {
  const key = Buffer.alloc(8, 'S3RVER', 'utf8');
  const iv = crypto.randomBytes(8);
  // ensure the first byte of IV lies between [212, 216)
  iv[0] = (iv[0] & 0b00000011) | 0b11010100;
  // use DES for its 8-byte block size
  // (real S3 has blocks of lengths [9,8,7] repeating)
  const cipher = crypto.createCipheriv('des', key, iv);
  return Buffer.concat([
    iv,
    cipher.update(`${region}/${bucket}/${keyName}`, 'utf8'),
    cipher.final(),
  ]).toString('base64');
}

function decipherContinuationToken(token) {
  const buf = Buffer.from(token, 'base64');
  if (buf.length < 8) return '';
  const key = Buffer.alloc(8, 'S3RVER', 'utf8');
  const iv = buf.slice(0, 8);
  const decipher = crypto.createDecipheriv('des', key, iv);
  const ciphertext = buf.slice(8);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

exports.bucketExists = async function bucketExists(ctx, next) {
  const bucketName = ctx.params.bucket;
  const bucket = await ctx.app.store.getBucket(bucketName);
  if (!bucket) {
    ctx.logger.error('No bucket found for "%s"', bucketName);
    throw new S3Error('NoSuchBucket', 'The specified bucket does not exist', {
      BucketName: bucketName,
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
  'acl',
  'analytics',
  'cors',
  'delete',
  'encryption',
  'inventory',
  'lifecycle',
  'location',
  'metrics',
  'notification',
  'object-lock',
  'policy',
  'policyStatus',
  'publicAccessBlock',
  'replication',
  'requestPayment',
  'tagging',
  'uploads',
  'versions',
  'website',
];

/**
 * DELETE Bucket
 * Deletes the bucket named in the URI. All objects (including all object versions and delete
 * markers) in the bucket must be deleted before the bucket itself can be deleted.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketDELETE.html}
 */
exports.deleteBucket = async function deleteBucket(ctx) {
  const { objects } = await ctx.store.listObjects(ctx.params.bucket, {
    maxKeys: 1,
  });
  if (objects.length) {
    throw new S3Error(
      'BucketNotEmpty',
      'The bucket your tried to delete is not empty',
      { BucketName: ctx.params.bucket },
    );
  }
  await ctx.store.deleteBucket(ctx.params.bucket);
  ctx.status = 204;
};

/**
 * DELETE Bucket cors
 * Deletes the cors configuration information set for the bucket.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketDELETEcors.html}
 */
exports.deleteBucketCors = async function deleteBucketCors(ctx) {
  await ctx.store.deleteSubresource(ctx.params.bucket, undefined, 'cors');
  ctx.body = '';
};

/**
 * DELETE Bucket website
 * This operation removes the website configuration for a bucket. Amazon S3
 * returns a 200 OK response upon successfully deleting a website configuration
 * on the specified bucket. You will get a 200 OK response if the website
 * configuration you are trying to delete does not exist on the bucket. Amazon
 * S3 returns a 404 response if the bucket specified in the request does not
 * exist.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketDELETEwebsite.html}
 */
exports.deleteBucketWebsite = async function deleteBucketWebsite(ctx) {
  await ctx.store.deleteSubresource(ctx.params.bucket, undefined, 'website');
  ctx.body = '';
};

/**
 * GET Bucket (List Objects) Version 1/2
 * This implementation of the GET operation returns some or all (up to 1,000) of the objects in a
 * bucket.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketGET.html}
 */
exports.getBucket = async function getBucket(ctx) {
  const options = {
    delimiter: ctx.query.delimiter || undefined,
    encodingType: ctx.query['encoding-type'], // currently unimplemented
    maxKeys: 1000,
    startAfter: undefined,
    prefix: ctx.query.prefix || undefined,
    fetchOwner: undefined,
  };
  if (ctx.query['max-keys']) {
    if (!ctx.query['max-keys'].match(/^-?\d+$/)) {
      throw new S3Error(
        'InvalidArgument',
        'Provided max-keys not an integer or within integer range',
        {
          ArgumentName: 'max-keys',
          ArgumentValue: ctx.query['max-keys'],
        },
      );
    }
    const maxKeys = Number(ctx.query['max-keys']);
    if (maxKeys < 0 || maxKeys > 2147483647) {
      throw new S3Error(
        'InvalidArgument',
        'Argument maxKeys must be an integer between 0 and 2147483647',
        {
          ArgumentName: 'maxKeys',
          ArgumentValue: maxKeys,
        },
      );
    }
    options.maxKeys = Math.min(1000, maxKeys);
  }
  switch (ctx.query['list-type']) {
    case '2':
      if ('marker' in ctx.query) {
        throw new S3Error(
          'InvalidArgument',
          'Marker unsupported with REST.GET.BUCKET in list-type=2',
          { ArgumentName: 'marker' },
        );
      }
      if (ctx.query['continuation-token']) {
        const token = decipherContinuationToken(
          ctx.query['continuation-token'],
        );
        const [, region, bucket, startAfter] =
          /([\w-.]+)\/([\w-.]+)\/(.+)/.exec(token) || [];
        if (region !== 'us-east-1' || bucket !== ctx.params.bucket) {
          throw new S3Error(
            'InvalidArgument',
            'The continuation token provided is incorrect',
            { ArgumentName: 'continuation-token' },
          );
        }
        options.startAfter = startAfter;
      } else {
        options.startAfter = ctx.query['start-after'];
      }
      options.fetchOwner = ctx.query['fetch-owner'] === 'true';
      break;
    default:
      // fall back to version 1
      if ('continuation-token' in ctx.query) {
        throw new S3Error(
          'InvalidArgument',
          'continuation-token only supported in REST.GET.BUCKET with list-type=2',
          { ArgumentName: 'continuation-token' },
        );
      }
      if ('start-after' in ctx.query) {
        throw new S3Error(
          'InvalidArgument',
          // yes, for some reason they decided to camelCase the start-after argument in this error message
          'startAfter only supported in REST.GET.BUCKET with list-type=2',
          { ArgumentName: 'start-after' },
        );
      }
      options.fetchOwner = true;
      options.startAfter = ctx.query.marker;
      break;
  }
  ctx.logger.info(
    'Fetched bucket "%s" with options %j',
    ctx.params.bucket,
    options,
  );
  try {
    const result =
      options.maxKeys === 0
        ? {
            objects: [],
            commonPrefixes: [],
            isTruncated: false,
          }
        : await ctx.store.listObjects(ctx.params.bucket, options);
    ctx.logger.info(
      'Found %d objects for bucket "%s"',
      result.objects.length,
      ctx.params.bucket,
    );
    ctx.body = {
      ListBucketResult: {
        '@': { xmlns: 'http://doc.s3.amazonaws.com/2006-03-01/' },
        Name: ctx.params.bucket,
        Prefix: options.prefix || '', // never omit
        ...(ctx.query['list-type'] === '2'
          ? {
              StartAfter: ctx.query['continuation-token']
                ? undefined
                : options.startAfter,
              ContinuationToken: ctx.query['continuation-token'] || undefined,
              NextContinuationToken: result.isTruncated
                ? generateContinuationToken(
                    ctx.params.bucket,
                    result.objects[result.objects.length - 1].key,
                    'us-east-1',
                  )
                : undefined,
              KeyCount: result.objects.length,
            }
          : {
              Marker: options.startAfter || '', // never omit
              NextMarker:
                options.delimiter && result.isTruncated
                  ? result.objects[result.objects.length - 1].key
                  : undefined,
            }),
        MaxKeys: ctx.query['max-keys'] || 1000, // S3 has a hard limit at 1000 but will still echo back the original input
        Delimiter: options.delimiter || undefined, // omit when "" or undefined
        IsTruncated: result.isTruncated || false,
        Contents: result.objects.map((object) => ({
          Key: object.key,
          LastModified: object.lastModifiedDate.toISOString(),
          ETag: object.metadata.etag,
          Size: object.size,
          Owner: options.fetchOwner
            ? {
                ID: DUMMY_ACCOUNT.id,
                DisplayName: DUMMY_ACCOUNT.displayName,
              }
            : undefined,
          StorageClass: 'STANDARD',
        })),
        CommonPrefixes: result.commonPrefixes.map((prefix) => ({
          Prefix: prefix,
        })),
      },
    };
  } catch (err) {
    ctx.logger.error(
      'Error listing objects in bucket "%s"',
      ctx.params.bucket,
      err,
    );
    throw err;
  }
};

/**
 * GET Bucket cors
 * Returns the cors configuration information set for the bucket.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketGETcors.html}
 */
exports.getBucketCors = async function getBucketCors(ctx) {
  const config = await ctx.store.getSubresource(
    ctx.params.bucket,
    undefined,
    'cors',
  );
  if (!config) {
    throw new S3Error(
      'NoSuchCORSConfiguration',
      'The CORS configuration does not exist',
      { BucketName: ctx.params.bucket },
    );
  }
  ctx.type = 'application/xml';
  ctx.body = config.toXML();
};

/**
 * GET Bucket location
 * This implementation of the GET operation returns the location configuration
 * associated with a bucket.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketGETlocation.html}
 */
exports.getBucketLocation = async function getBucketLocation(ctx) {
  // always return default bucket location
  ctx.body = {
    LocationConstraint: {
      '@': { xmlns: 'http://doc.s3.amazonaws.com/2006-03-01/' },
    },
  };
};

/**
 * GET Bucket website
 * This implementation of the GET operation returns the website configuration
 * associated with a bucket. To host website on Amazon S3, you can configure a
 * bucket as website by adding a website configuration.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketGETwebsite.html}
 */
exports.getBucketWebsite = async function getBucketWebsite(ctx) {
  const config = await ctx.store.getSubresource(
    ctx.params.bucket,
    undefined,
    'website',
  );
  if (!config) {
    throw new S3Error(
      'NoSuchWebsiteConfiguration',
      'The specified bucket does not have a website configuration',
      { BucketName: ctx.params.bucket },
    );
  }
  ctx.type = 'application/xml';
  ctx.body = config.toXML();
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
      bucketName,
    );
    throw new S3Error(
      'InvalidBucketName',
      'Bucket names can contain lowercase letters, numbers, and hyphens. ' +
        'Each label must start and end with a lowercase letter or a number.',
    );
  }
  if (bucketName.length < 3 || bucketName.length > 63) {
    ctx.logger.error(
      'Error creating bucket "%s" because the name is invalid',
      bucketName,
    );
    throw new S3Error(
      'InvalidBucketName',
      'The bucket name must be between 3 and 63 characters.',
    );
  }
  const bucket = await ctx.store.getBucket(bucketName);
  if (bucket) {
    ctx.logger.error(
      'Error creating bucket. Bucket "%s" already exists',
      bucketName,
    );
    throw new S3Error(
      'BucketAlreadyExists',
      'The requested bucket already exists',
    );
  }
  await ctx.store.putBucket(bucketName);
  ctx.logger.info('Created new bucket "%s" successfully', bucketName);
  ctx.set('Location', '/' + bucketName);
  ctx.body = '';
};

/**
 * PUT Bucket cors
 * Sets the cors configuration for your bucket. If the configuration exists,
 * Amazon S3 replaces it.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketPUTcors.html}
 */
exports.putBucketCors = async function putBucketCors(ctx) {
  await utf8BodyParser(ctx);
  const config = S3CorsConfiguration.validate(ctx.request.body);
  await ctx.store.putSubresource(ctx.params.bucket, undefined, config);
  ctx.body = '';
};

/**
 * PUT Bucket website
 * Sets the configuration of the website that is specified in the website
 * subresource. To configure a bucket as a website, you can add this
 * subresource on the bucket with website configuration information such as the
 * file name of the index document and any redirect rules.
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketPUTwebsite.html}
 */
exports.putBucketWebsite = async function putBucketWebsite(ctx) {
  await utf8BodyParser(ctx);
  const config = S3WebsiteConfiguration.validate(ctx.request.body);
  await ctx.store.putSubresource(ctx.params.bucket, undefined, config);
  ctx.body = '';
};
