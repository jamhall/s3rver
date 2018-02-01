'use strict';

const FileStore = require('./file-store');
const templateBuilder = require('./xml-template-builder');
const concat = require('concat-stream');
const xml2js = require('xml2js');
const async = require('async');
const path = require('path');
const ReadableStream = require('stream').Readable;
const crypto = require('crypto');
const url = require('url');
const S3Event = require('./models/s3-event');


module.exports = function (rootDirectory, logger, indexDocument, errorDocument) {
  const fileStore = new FileStore(rootDirectory);

  const buildXmlResponse = function (res, status, template) {
    res.header('Content-Type', 'application/xml');
    res.status(status);
    return res.send(template);
  };

  const buildResponse = function (req, res, status, object, data) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Etag', '"' + object.md5 + '"');
    res.header('Last-Modified', new Date(object.modifiedDate).toUTCString());
    res.setHeader('Content-Type', object.contentType);

    if (object.contentEncoding)
      res.header('Content-Encoding', object.contentEncoding);

    if (object.contentDisposition)
      res.header('Content-Disposition', object.contentDisposition);

    if (data.range) {
      var end = Math.min(data.range.end || Infinity, object.size - 1);
      res.header('Content-Range', 'bytes ' + data.range.start + '-' + end + '/' + object.size);
      res.header('Accept-Ranges', 'bytes');
      res.header('Content-Length', end - data.range.start + 1);
    }
    else {
      res.header('Content-Length', object.size);
    }

    if (object.customMetaData.length > 0) {
      object.customMetaData.forEach(function (metaData) {
        res.header(metaData.key, metaData.value);
      });
    }
    res.status(status);
    if (req.method === 'HEAD') {
      return res.end();
    }
    return data.pipe(res);
  };

  const triggerS3Event = function (req, res, eventData) {
    res.app.s3Event.next(new S3Event(eventData, req.headers))
  }

  const errorResponse = function (req, res, keyName) {
    logger.error('Object "%s" in bucket "%s" does not exist', keyName, req.bucket.name);

    if (indexDocument) {
      if (errorDocument) {
        fileStore.getObject(req.bucket, errorDocument, function (err, object, data) {
          if (err) {
            console.error('Custom Error Document not found: ' + errorDocument);
            return notFoundResponse(req, res);
          }
          else {
            return buildResponse(req, res, 404, object, data);
          }
        });
      }
      else {
        return notFoundResponse(req, res);
      }
    }
    else {
      const template = templateBuilder.buildKeyNotFound(keyName);
      return buildXmlResponse(res, 404, template);
    }
  };


  const notFoundResponse = function (req, res) {
    const ErrorDoc = '<!DOCTYPE html>\n<html><head><title>404 - Resource Not Found</title></head><body><h1>404 - Resource Not Found</h1></body></html>';
    const stream = new ReadableStream();
    stream.push(ErrorDoc);
    stream.push(null);

    return buildResponse(req, res, 404, {
      modifiedDate: new Date(),
      contentType: 'text/html',
      customMetaData: [],
      size: ErrorDoc.length
    }, stream);
  };

  const deleteObjects = function (req, res) {
    xml2js.parseString(req.body, function (err, parsedBody) {
      const keys = parsedBody.Delete.Object.map(function (o) {
        return o.Key[0];
      });
      async.each(keys, function (key, cb) {
        fileStore.getObjectExists(req.bucket, key, function (err) {
          if (err) {
            return cb();
          }
          fileStore.deleteObject(req.bucket, key, function (err) {
            if (err) {
              logger.error('Could not delete object "%s"', key, err);
              const template = templateBuilder.buildError('InternalError',
                'We encountered an internal error. Please try again.');
              cb(err);
              return buildXmlResponse(res, 500, template);
            }
            logger.info('Deleted object "%s" in bucket "%s"', key, req.bucket.name);
            cb();
          });
        });
      }, function (err) {
        if (err) return;
        const template = templateBuilder.buildObjectsDeleted(keys);
        return buildXmlResponse(res, 200, template);
      });
    });
  };

  const handleCopyObject = function (key, req, res) {
    let template;
    let copy = req.headers['x-amz-copy-source'];
    copy = copy.charAt(0) === '/' ? copy : '/' + copy;
    const srcObjectParams = copy.split('/'), srcBucket = srcObjectParams[1], srcObject = srcObjectParams.slice(2).join('/');
    fileStore.getBucket(srcBucket, function (err, bucket) {
      if (err) {
        logger.error('No bucket found for "%s"', srcBucket);
        template = templateBuilder.buildBucketNotFound(srcBucket);
        return buildXmlResponse(res, 404, template);
      }
      fileStore.getObject(bucket, srcObject, function (err) {
        if (err) {
          logger.error('Object "%s" in bucket "%s" does not exist', srcObject, bucket.name);
          template = templateBuilder.buildKeyNotFound(srcObject);
          return buildXmlResponse(res, 404, template);
        }

        const replaceMetadata = req.headers['x-amz-metadata-directive'] === 'REPLACE';
        fileStore.copyObject({
          request: req,
          srcKey: srcObject,
          srcBucket: bucket,
          destBucket: req.bucket,
          destKey: key,
          replaceMetadata: replaceMetadata

        }, function (err, object) {
          if (err) {
            logger.error('Error copying object "%s" from bucket "%s" into bucket "%s" with key of "%s"',
              srcObject, bucket.name, req.bucket.name, key);
            template = templateBuilder.buildError('InternalError',
              'We encountered an internal error. Please try again.');
            return buildXmlResponse(res, 500, template);
          }

          logger.info('Copied object "%s" from bucket "%s"  into bucket "%s" with key of "%s"',
            srcObject, bucket.name, req.bucket.name, key);
          triggerS3Event(req, res, { bucket: req.bucket.name, eventType: 'Copy', S3Item: object });
          template = templateBuilder.buildCopyObject(object);
          return buildXmlResponse(res, 200, template);
        });
      });
    });
  };

  const putObjectMultipart = function (req, res) {
    const partKey = req.query.uploadId + '_' + req.query.partNumber;
    if (req.headers['x-amz-copy-source']) {
      handleCopyObject(partKey, req, res);
    } else {
      fileStore.putObject(req.bucket, partKey, req, function (err, key) {
        if (err) {
          logger.error('Error uploading object "%s" to bucket "%s"',
            partKey, req.bucket.name, err);
          const template = templateBuilder.buildError('InternalError',
            'We encountered an internal error. Please try again.');
          return buildXmlResponse(res, 500, template);
        }
        logger.info('Stored object "%s" in bucket "%s" successfully', partKey, req.bucket.name);
        res.header('ETag', '"' + key.md5 + '"');
        return res.status(200).end();
      });
    }
  };

  /**
   * The following methods correspond the S3 api. For more information visit:
   * http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html
   */
  return {
    /**
     * Middleware to check if a bucket exists
     */
    bucketExists: function (req, res, next) {
      const bucketName = req.params.bucket;
      fileStore.getBucket(bucketName, function (err, bucket) {
        if (err) {
          logger.error('No bucket found for "%s"', bucketName);
          const template = templateBuilder.buildBucketNotFound(bucketName);
          return buildXmlResponse(res, 404, template);
        }
        req.bucket = bucket;
        return next();
      });
    },
    getBuckets: function (req, res) {
      const buckets = fileStore.getBuckets();
      logger.info('Fetched %d buckets', buckets.length);
      const template = templateBuilder.buildBuckets(buckets);
      return buildXmlResponse(res, 200, template);
    },
    getBucket: function (req, res) {

      const options = {
        bucketName: req.bucket.name || null,
        marker: req.query.marker || null,
        prefix: req.query.prefix || null,
        maxKeys: parseInt(req.query['max-keys']) || 1000,
        delimiter: req.query.delimiter || null
      };

      if (indexDocument) {
        fileStore.getObject(req.bucket, indexDocument, function (err, object, data) {
          if (err) {
            return errorResponse(req, res, indexDocument);
          }
          else {
            logger.info('Serving Page: %s', object.key);
            return buildResponse(req, res, 200, object, data);
          }
        });
      }
      else {
        logger.info('Fetched bucket "%s" with options %s', req.bucket.name, options);
        fileStore.getObjects(req.bucket, options, function (err, results) {
          logger.info('Found %d objects for bucket "%s"', results.objects.length, req.bucket.name);
          const template = templateBuilder.buildBucketQuery(options, results);
          return buildXmlResponse(res, 200, template);
        });
      }
    },
    putBucket: function (req, res) {
      const bucketName = req.params.bucket;
      let template;
      /**
       * Derived from http://docs.aws.amazon.com/AmazonS3/latest/dev/BucketRestrictions.html
       */
      if ((/^[a-z0-9]+(.?[-a-z0-9]+)*$/.test(bucketName) === false)) {
        template = templateBuilder.buildError('InvalidBucketName',
          'Bucket names can contain lowercase letters, numbers, and hyphens. ' +
          'Each label must start and end with a lowercase letter or a number.');
        logger.error('Error creating bucket "%s" because the name is invalid', bucketName);
        return buildXmlResponse(res, 400, template);
      }
      if (bucketName.length < 3 || bucketName.length > 63) {
        logger.error('Error creating bucket "%s" because the name is invalid', bucketName);
        template = templateBuilder.buildError('InvalidBucketName',
          'The bucket name must be between 3 and 63 characters.');
        return buildXmlResponse(res, 400, template);
      }
      fileStore.getBucket(bucketName, function (err, bucket) {
        if (bucket) {
          logger.error('Error creating bucket. Bucket "%s" already exists', bucketName);
          const template = templateBuilder.buildError('BucketAlreadyExists',
            'The requested bucket already exists');
          return buildXmlResponse(res, 409, template);
        }
        fileStore.putBucket(bucketName, function (err) {
          if (err) {
            logger.error('Error creating bucket "%s"', err);
            const template = templateBuilder.buildError('InternalError',
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
          const template = templateBuilder.buildBucketNotEmpty(req.bucket.name);
          return buildXmlResponse(res, 409, template);
        }
        return res.status(204).end();
      });
    },
    getObject: function (req, res) {
      let keyName = req.params.key;
      const acl = req.query.acl;
      if (acl !== undefined) {
        const template = templateBuilder.buildAcl();
        return buildXmlResponse(res, 200, template);
      }
      fileStore.getObject(req.bucket, keyName, req.headers.range, function (err, object, data) {
        if (err) {

          if (indexDocument) {
            keyName = path.join(keyName, indexDocument);
            return fileStore.getObject(req.bucket, keyName, function (err, object, data) {
              if (err) {
                return errorResponse(req, res, keyName);
              }
              else {
                return buildResponse(req, res, 200, object, data);
              }
            });
          }
          else {
            return errorResponse(req, res, keyName);
          }
        }

        const noneMatch = req.headers['if-none-match'];
        if (noneMatch && (noneMatch === '"' + object.md5 + '"' || noneMatch === '*')) {
          return res.status(304).end();
        }
        const modifiedSince = req.headers['if-modified-since'];
        if (modifiedSince) {
          const time = new Date(modifiedSince);
          const modifiedDate = new Date(object.modifiedDate);
          if (time >= modifiedDate) {
            return res.status(304).end();
          }
        }

        return buildResponse(req, res, req.headers.range ? 206 : 200, object, data);
      });
    },
    putObject: function (req, res) {
      if (req.query.uploadId) {
        return putObjectMultipart(req, res);
      }

      if (req.headers['x-amz-copy-source']) {
        return handleCopyObject(req.params.key, req, res);
      } else {
        fileStore.putObject(req.bucket, req.params.key, req, function (err, key) {
          if (err) {
            logger.error('Error uploading object "%s" to bucket "%s"',
              req.params.key, req.bucket.name, err);
            const template = templateBuilder.buildError('InternalError',
              'We encountered an internal error. Please try again.');
            return buildXmlResponse(res, 500, template);
          }
          logger.info('Stored object "%s" in bucket "%s" successfully', req.params.key, req.bucket.name);
          triggerS3Event(req, res, { bucket: req.bucket.name, eventType: 'Put', S3Item: key });
          res.header('ETag', '"' + key.md5 + '"');
          return res.status(200).end();
        });
      }
    },
    postObject: function (req, res) {
      if (req.query.uploads !== undefined) {
        var uploadId = crypto.randomBytes(16).toString('hex');
        return buildXmlResponse(res, 200, templateBuilder.buildInitiateMultipartUploadResult(req.bucket.name, req.params.key, uploadId));
      } else {
        let completeMultipartUploadXml = '';

        req.on('data', function (data) {
          completeMultipartUploadXml += data.toString('utf8');
        });

        req.on('end', function () {
          xml2js.parseString(completeMultipartUploadXml, function (err, result) {
            if (err) {
              logger.error('Error completing multipart upload "%s" for object "%s" in bucket "%s"',
                req.query.uploadId, req.params.key, req.bucket.name, err);
              const template = templateBuilder.buildError('XMLParseError', err.message);
              return buildXmlResponse(res, 400, template);
            }

            const parts = result.CompleteMultipartUpload.Part.map(function (part) {
              return {
                number: part.PartNumber[0],
                etag: part.ETag[0].replace('"', '')
              };
            });

            fileStore.combineObjectParts(req.bucket, req.params.key, req.query.uploadId, parts, req, function (err, key) {
              if (err) {
                logger.error('Error uploading object "%s" to bucket "%s"',
                  req.params.key, req.bucket.name, err);
                const template = templateBuilder.buildError('InternalError',
                  'We encountered an internal error. Please try again.');
                return buildXmlResponse(res, 500, template);
              }

              logger.info('Stored object "%s" in bucket "%s" successfully', req.params.key, req.bucket.name);
              const location = req.protocol + '://' + req.get('Host') + url.parse(req.originalUrl).pathname;
              triggerS3Event(req, res, { bucket: req.bucket.name, eventType: 'Post', S3Item: key });
              return buildXmlResponse(res, 200,
                templateBuilder.buildCompleteMultipartUploadResult(req.bucket.name, req.params.key, location, key)
              );
            });
          });
        });
      }
    },
    deleteObject: function (req, res) {
      const key = req.params.key;
      fileStore.getObjectExists(req.bucket, key, function (err) {
        if (err) {
          return res.status(204).end();
        }
        fileStore.deleteObject(req.bucket, key, function (err) {
          if (err) {
            logger.error('Could not delete object "%s"', key, err);
            const template = templateBuilder.buildError('InternalError',
              'We encountered an internal error. Please try again.');
            return buildXmlResponse(res, 500, template);
          }
          logger.info('Deleted object "%s" in bucket "%s"', key, req.bucket.name);
          triggerS3Event(req, res, { bucket: req.bucket.name, eventType: 'Delete', S3Item: { key: key } });
          return res.status(204).end();
        });
      });
    },
    genericPost: function (req, res) {
      if (req.query.delete !== undefined)
        req.pipe(concat(function (data) {
          req.body = data;
          deleteObjects(req, res);
        }));
      else
        notFoundResponse(req, res);
    }
  };
};
