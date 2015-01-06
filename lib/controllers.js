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
    /**
     * Middleware to check if a bucket exists
     */
    bucketExists: function (req, res, next) {
      var bucketName = req.params.bucket;
      fileStore.getBucket(bucketName, function (err, bucket) {
        if (err) {
          logger.error('No bucket found for "%s"', bucketName);
          var template = templateBuilder.buildBucketNotFound(bucketName);
          return buildXmlResponse(res, 404, template);
        }
        req.bucket = bucket;
        return next();
      });
    },
    getBuckets: function (req, res) {
      var buckets = fileStore.getBuckets();
      logger.info('Fetched %d buckets', buckets.length);
      var template = templateBuilder.buildBuckets(buckets);
      return buildXmlResponse(res, 200, template);
    },
    getBucket: function (req, res) {
      var options = {
        marker: req.query.marker || null,
        prefix: req.query.prefix || null,
        maxKeys: req.query['max-keys'] || 1000,
        delimiter: req.query.delimiter || null
      };
      logger.info('Fetched bucket "%s" with options %s', req.bucket.name, options);
      fileStore.getObjects(req.bucket, options, function (err, results) {
        logger.info('Found %d objects for bucket "%s"', results.length, req.bucket.name);
        var template = templateBuilder.buildBucketQuery(options, results);
        return buildXmlResponse(res, 200, template);
      });
    },
    putBucket: function (req, res) {
      var bucketName = req.params.bucket;
      /**
       * Derived from http://docs.aws.amazon.com/AmazonS3/latest/dev/BucketRestrictions.html
       */
      if ((/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bucketName) === false)) {
        var template = templateBuilder.buildError('InvalidBucketName',
            'Bucket names can contain lowercase letters, numbers, and hyphens. ' +
            'Each label must start and end with a lowercase letter or a number.');
        return buildXmlResponse(res, 400, template);
      }
      if (bucketName.length < 3 || bucketName.length > 63) {
        var template = templateBuilder.buildError('InvalidBucketName',
          'The bucket name must be between 3 and 63 characters.');
        return buildXmlResponse(res, 400, template);
      }
      fileStore.getBucket(bucketName, function (err, bucket) {
        if (bucket) {
          logger.error('Error creating bucket. Bucket "%s" already exists', bucketName);
          var template = templateBuilder.buildError('BucketAlreadyExists',
            'The requested bucket already exists');
          return buildXmlResponse(res, 409, template);
        }
        fileStore.putBucket(bucketName, function (err, bucket) {
          if (err) {
            logger.error('Error creating bucket "%s"', err);
            var template = templateBuilder.buildError('InternalError',
              'We encountered an internal error. Please try again.');
            return buildXmlResponse(res, 500, template);
          }
          logger.info('Created new bucket "%s" successfully', bucketName);
          res.header('Location', '/' + bucketName);
          return res.status(200).send();
        });
      });
    },
    deleteBucket: function (req, res) {
      fileStore.deleteBucket(req.bucket, function (err) {
        if (err) {
          var template = templateBuilder.buildBucketNotEmpty(bucketName);
          return buildXmlResponse(res, 409, template);
        }
        return res.status(204).end();
      });
    },
    getObject: function (req, res) {
      var keyName = req.params.key;
      var acl = req.query.acl;
      if (acl !== undefined) {
        var template = templateBuilder.buildAcl();
        return buildXmlResponse(res, 200, template);
      }
      fileStore.getObject(req.bucket, keyName, function (err, object, data) {
        if (err) {
          var template = templateBuilder.buildKeyNotFound(keyName);
          return buildXmlResponse(res, 404, template);
        }

        var noneMatch = req.headers['if-none-match'];
        if (noneMatch && (noneMatch == object.md5 || noneMatch == '*')) {
          return res.status(304).end();
        }
        var modifiedSince = req.headers['if-modified-since'];
        if (modifiedSince) {
          var time = new Date(modifiedSince);
          var modifiedDate = new Date(object.modifiedDate);
          if (time >= modifiedDate) {
            return res.status(304).end();
          }
        }
        res.header('Etag', object.md5);
        res.header('Last-Modified', new Date(object.modifiedDate).toUTCString());
        res.header('Content-Type', object.contentType);
        res.header('Content-Length', object.size);
        res.status(200);
        if (req.method === 'HEAD') {
          return res.end();
        }
        return res.end(data);
      });
    },
    putObject: function (req, res) {
      fileStore.putObject(req.bucket, req, function (err, key) {
        if (err) {
          logger.error('Error uploading object "%s" to bucket "%s"',
            req.params.key, req.bucket.name, err);
          return res.status(400).json('Error uploading file');
        }
        logger.info('Stored object "%s" in bucket "%s" successfully', req.params.key, req.bucket.name);
        res.header('ETag', key.md5);
        return res.status(200).end();
      });
    },
    deleteObject: function (req, res) {
      var key = req.params.key;
      fileStore.getObjectExists(req.bucket, key, function (err) {
        if (err) {
          var template = templateBuilder.buildKeyNotFound(keyName);
          return buildXmlResponse(res, 404, template);
        }
        fileStore.deleteObject(req.bucket, key, function (err) {
          if (err) {
            logger.error('Could not delete object "%s"', key, err);
            var template = templateBuilder.buildError('InternalError',
              'We encountered an internal error. Please try again.');
            return buildXmlResponse(res, 500, template);
          }
          logger.info('Deleted object "%s" in bucket "%s"', key, req.bucket.name);
          return res.status(204).end();
        });
      });
    }
  }
};
