'use strict';

module.exports = function (rootDirectory) {
  var FileStore = require('./file-store'),
      fileStore = new FileStore(rootDirectory),
      templateBuilder = require('./xml-template-builder'),
      logger = require('./logger');
  var buildXmlResponse = function (res, status, template) {
    res.header('Content-Type', 'application/xml');
    res.status(status);
    return res.send(template);
  };
  return {
    getAllBuckets: function (req, res) {
      var buckets = fileStore.getAllBuckets();
      logger.info('Fetched %d buckets', buckets.length);
      var template = templateBuilder.buildBuckets(buckets);
      return buildXmlResponse(res, 200, template);
    },
    getBucket: function (req, res) {
      var acl = req.query.acl;
      var bucketName = req.params.bucket;
      if (acl) {
        return res.send('Getting acl');
      } else {
        fileStore.getBucket(bucketName, function (err, bucket) {
          if (err) {
            logger.error('No bucket found for %s', bucketName);
            var template = templateBuilder.buildBucketNotFound(bucketName);
            return buildXmlResponse(res, 404, template);
          }
          var options = {
            marker: req.query.marker || null,
            prefix: req.query.prefix || null,
            maxKeys: req.query['max-keys'] || 1000,
            delimiter: req.query.delimiter || null
          };
          logger.info('Fetched bucket %s with options %s', bucketName, options);
          fileStore.getAllKeysForBucket(bucket, options, function (err, results) {
            logger.info('Found %d keys for bucket %s', results.length, bucketName);
            var template = templateBuilder.buildBucketQuery(options, results);
            return buildXmlResponse(res, 200, template);
          });
        });
      }
    },
    putBucket: function (req, res) {
      var bucketName = req.params.bucket;
      /**
       * Derived from http://docs.aws.amazon.com/AmazonS3/latest/dev/BucketRestrictions.html
       */
      if ((/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bucketName) === false)) {
        var template = templateBuilder.buildError('BucketNameInvalid', 'Bucket names can contain lowercase letters, numbers, and hyphens. ' +
          'Each label must start and end with a lowercase letter or a number.');
        return buildXmlResponse(res, 400, template);
      }
      if (bucketName.length < 3 || bucketName.length > 63) {
        var template = templateBuilder.buildError('BucketNameLength', 'The bucket name must be between 3 and 63 characters.');
        return buildXmlResponse(res, 400, template);
      }
      fileStore.getBucket(bucketName, function (err, bucket) {
        if (bucket) {
          var template = templateBuilder.buildError('BucketAlreadyExists', 'The requested bucket already exists');
          return buildXmlResponse(res, 409, template);
        }
        fileStore.createBucket(bucketName, function (err, bucket) {
          if (err) {
            var template = templateBuilder.buildError('InternalError', 'We encountered an internal error. Please try again.');
            return buildXmlResponse(res, 500, template);
          }
          res.header('Location', '/' + bucketName);
          return res.status(200).send();
        });
      });
    },
    deleteBucket: function (req, res) {
      var bucketName = req.params.bucket;
      fileStore.getBucket(bucketName, function (err, bucket) {
        res.header('Content-Type', 'application/xml');
        if (err) {
          var template = templateBuilder.buildBucketNotFound(bucketName);
          return buildXmlResponse(res, 404, template);
        }
        fileStore.deleteBucket(bucket, function (err) {
          if (err) {
            var template = templateBuilder.buildBucketNotEmpty(bucketName);
            return buildXmlResponse(res, 409, template);
          }
          return res.status(204).end();
        });
      });
    },
    getKeyForBucket: function (req, res) {
      var bucketName = req.params.bucket;
      var keyName = req.params.key;
      fileStore.getBucket(bucketName, function (err, bucket) {
        if (err) {
          var template = templateBuilder.buildBucketNotFound(bucketName);
          return buildXmlResponse(res, 404, template);
        }
        fileStore.getKeyForBucket(bucket, keyName, function (err, key, data) {
          if (err) {
            var template = templateBuilder.buildKeyNotFound(keyName);
            return buildXmlResponse(res, 404, template);
          }

          var noneMatch = req.headers['if-none-match'];
          if (noneMatch && (ifNoneMatch == key.md5 || ifNoneMatch == '*')) {
            return res.status(304).end();
          }
          var modifiedSince = req.headers['if-modified-since'];
          if (modifiedSince) {
            var time = new Date(modifiedSince);
            var modifiedDate = new Date(key.modifiedDate);
            if (time >= modifiedDate) {
              return res.status(304).end();
            }
          }
          res.header('Etag', key.md5);
          res.header('Last-Modified', new Date(key.modifiedDate).toUTCString());
          res.header('Content-Type', key.contentType);
          return res.status(200).end(data);
        });
      });
    },
    putKeyForBucket: function (req, res) {
      var bucketName = req.params.bucket;
      res.header('Content-Type', 'text/xml');
      fileStore.getBucket(bucketName, function (err, bucket) {
        //TODO create bucket if it does not exist
        fileStore.storeKey(bucket, req, function (err, key) {
          if (err) {
            return res.status(400).json('Error uploading file');
          }
          res.header('ETag', key.md5);
          return res.status(200).end();
        });
      });
    }
  }
}
