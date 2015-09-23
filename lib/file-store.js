'use strict';
var path   = require('path'),
    fs     = require('fs-extra'),
    async  = require('async'),
    md5    = require('MD5'),
    mkdirp = require('mkdirp'),
    utils  = require('./utils'),
    _      = require('lodash');

var FileStore = function (rootDirectory) {
  var CONTENT_FILE  = '.dummys3_content',
      METADATA_FILE = '.dummys3_metadata',
      Bucket        = require('./models/bucket'),
      S3Object      = require('./models/s3-object');

  var getBucketPath = function (bucketName) {
    return path.join(rootDirectory, bucketName).replace(/\\/g, '/');
  };

  var getBucket = function (bucketName, done) {
    var bucketPath = getBucketPath(bucketName);
    fs.stat(bucketPath, function (err, file) {
      if (err || !file.isDirectory()) {
        return done('Bucket not found');
      }
      return done(null, new Bucket(bucketName, file.ctime));
    });
  };

  var deleteBucket = function (bucket, done) {
    var bucketPath = getBucketPath(bucket.name);
    fs.rmdir(bucketPath, function (err) {
      if (err) {
        return done(err);
      }
      return done();
    });
  };

  var getBuckets = function () {
    var buckets = [];
    fs.readdirSync(rootDirectory).filter(function (result) {
      var file = fs.statSync(path.resolve(rootDirectory, result));
      if (file.isDirectory()) {
        buckets.push(new Bucket(result, file.ctime));
      }
    });
    return buckets;
  };

  var putBucket = function (bucketName, done) {
    var bucketPath = getBucketPath(bucketName);
    fs.mkdir(bucketPath, 502, function (err) {
      if (err) {
        return done(err);
      }
      return getBucket(bucketName, done);
    });
  };

  var getObject = function (bucket, key, done) {
    var filePath = path.resolve(getBucketPath(bucket.name), key);
    fs.exists(filePath, function (exists) {
      if (exists === false) {
        return done('Not found');
      }
      async.parallel([
        function (callback) {
          fs.readFile(path.join(filePath, CONTENT_FILE), function (err, data) {
            if (err) {
              return callback(err);
            }
            return callback(null, data);
          });
        },
        function (callback) {
          fs.readFile(path.join(filePath, METADATA_FILE), function (err, data) {
            if (err) {
              return callback(err);
            }
            callback(null, buildS3ObjectFromMetaDataFile(key, data));
          });
        }
      ], function (err, results) {
        if (err) {

          return done(err);
        }
        return done(null, results[1], results[0]);
      });
    });
  };

  var getObjects = function (bucket, options, done) {
    var bucketPath = getBucketPath(bucket.name);
    var matches = [];
    var commonPrefixesMap = {};
    var commonPrefixes = options.delimiter? []: undefined;
    var keys = utils.walk(bucketPath);
    var filteredKeys = _.filter(keys, function (file) {
      if (options.prefix) {
        var key = file.replace(/\\/g, '/').replace(bucketPath + '/', '');
        var match = (key.substring(0, options.prefix.length) === options.prefix);
        return match;
      }
      return true;
    });
    async.eachSeries(filteredKeys, function (key, callback) {
      key = key.replace(/\\/g, '/');
        fs.readFile(path.join(key, METADATA_FILE), function (err, data) {
          if (options.delimiter) {
            var match = key.replace(bucketPath + '/', '');
            var delimiterIndex = match.indexOf(options.delimiter, options.prefix? options.prefix.length: undefined);

            if (delimiterIndex > -1) {
              // All objects should map to common prefixes.
              match = match.substr(0, delimiterIndex);
              if (!commonPrefixesMap.hasOwnProperty(match)) {
                commonPrefixesMap[match] = true;
                commonPrefixes.push(match);
              }

              // Skip objects that do not pass the delimiter test.
              callback(null);
              return;
            }
          }

          if (data) {
            matches.push(buildS3ObjectFromMetaDataFile(key.replace(bucketPath + '/', ''), data));
          }
          callback(null);
        });
      }, function () {
        if (matches.length === 0) {
          return done(null, {
            objects: [],
            commonPrefixes: commonPrefixes
          });
        }
        // start at the specified marker
        var startAt = 0;
        var found = false;
        if (options.marker) {
          for (var i = 0; i <= matches.length - 1; i++) {
            if (matches[i].key === options.marker) {
              startAt = i;
              found = true;
              break;
            }
          }
          return done(null, {
            objects: (found? matches.slice(startAt, options.maxKeys) : []),
            commonPrefixes: commonPrefixes
          });
        }
        done(null, {
          objects: matches.slice(0, options.maxKeys),
          commonPrefixes: commonPrefixes
        });
      }
    );
  };

  var buildS3ObjectFromMetaDataFile = function (key, file) {
    var json = JSON.parse(file);
    var metaData = {
      key: key,
      md5: json.md5,
      contentType: json.contentType,
      contentEncoding: json.contentEncoding,
      size: json.size,
      modifiedDate: json.modifiedDate,
      creationDate: json.creationDate,
      customMetaData: json.customMetaData
    };
    return new S3Object(metaData);
  };

  var getCustomMetaData = function (headers) {
    var customMetaData = [];
    for (var header in headers) {
      if (/^x-amz-meta-(.*)$/.test(header)) {
        customMetaData.push({
          key: header,
          value: headers[header]
        });
      }
    }
    return customMetaData;
  };

  var createMetaData = function (data, done) {
    var contentFile = data.contentFile,
        type        = data.type,
        encoding    = data.encoding,
        metaFile    = data.metaFile,
        headers     = data.headers;
    async.parallel([
      function (callback) {
        fs.stat(contentFile, function (err, stats) {
          if (err) {
            return callback(err);
          }
          return callback(null, {
            mtime: stats.mtime,
            ctime: stats.ctime
          });
        });
      },
      function (callback) {
        fs.readFile(contentFile, function (err, data) {
          return callback(null, {
            size: data.length,
            md5: md5(data)
          });
        });
      }
    ], function (err, results) {
      var metaData = {
        md5: results[1].md5,
        contentType: type,
        size: results[1].size,
        modifiedDate: results[0].mtime,
        creationDate: results[0].ctime,
        customMetaData: getCustomMetaData(headers)
      };
      if (encoding)
        metaData.contentEncoding = encoding;

      fs.writeFile(metaFile, JSON.stringify(metaData), function (err) {
        if (err) {
          return done(err);
        }
        return done(null, metaData);
      });
    });
  };

  var putObject = function (bucket, req, done) {
    var keyName = path.join(bucket.name, req.params.key);
    var dirName = path.join(rootDirectory, keyName);
    mkdirp.sync(dirName);
    var contentFile = path.join(dirName, CONTENT_FILE);
    var metaFile = path.join(dirName, METADATA_FILE);
    var key = req.params.key;
    key = key.substr(key.lastIndexOf('/') + 1);
    fs.writeFile(contentFile, new Buffer(req.body), function (err) {
      if (err) {
        return done('Error writing file');
      }
      createMetaData({
        contentFile: contentFile,
        type: req.headers['content-type'],
        encoding: req.headers['content-encoding'],
        key: key,
        metaFile: metaFile,
        headers: req.headers
      }, function (err, metaData) {
        if (err) {
          return done('Error uploading file');
        }
        return done(null, new S3Object(metaData));
      });
    });
  };

  var copyObject = function (srcBucket, srcKey, destBucket, destKey, done) {
    var srcKeyPath           = path.resolve(getBucketPath(srcBucket.name), srcKey),
        destKeyPath          = path.resolve(getBucketPath(destBucket.name), destKey),
        srcMetadataFilePath  = path.join(srcKeyPath, METADATA_FILE),
        srcContentFilePath   = path.join(srcKeyPath, CONTENT_FILE),
        destMetadataFilePath = path.join(destKeyPath, METADATA_FILE),
        destContentFilePath  = path.join(destKeyPath, CONTENT_FILE);

    mkdirp.sync(destKeyPath);
    fs.copySync(srcMetadataFilePath, destMetadataFilePath);
    fs.copySync(srcContentFilePath, destContentFilePath);
    fs.readFile(destMetadataFilePath, function (err, data) {
      if (err) {
        return done(err);
      }
      done(null, buildS3ObjectFromMetaDataFile(destKey, data));
    });
  };

  var deleteObject = function (bucket, key, done) {
    var keyPath = path.resolve(getBucketPath(bucket.name), key);
    async.map([path.join(keyPath, METADATA_FILE),
      path.join(keyPath, CONTENT_FILE)], fs.unlink, function (err) {
      if (err) {
        return done(err);
      }
      fs.rmdir(keyPath, function () {
        return done();
      });
    });
  };

  var getObjectExists = function (bucket, key, done) {
    var keyPath = path.resolve(getBucketPath(bucket.name), key);
    fs.stat(keyPath, function (err, file) {
      if (err || !file.isDirectory()) {
        return done('Object not found for ' + keyPath);
      }
      return done(null);
    });
  };

  return {
    getBuckets: getBuckets,
    getBucket: getBucket,
    putBucket: putBucket,
    deleteBucket: deleteBucket,
    getObjects: getObjects,
    getObject: getObject,
    putObject: putObject,
    copyObject: copyObject,
    getObjectExists: getObjectExists,
    deleteObject: deleteObject
  };
};
module.exports = FileStore;
