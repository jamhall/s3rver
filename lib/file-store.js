'use strict';

var path = require('path');
var async = require('async');
var crypto = require('crypto');
var PassThrough = require('stream').PassThrough;
var utils = require('./utils');
var _ = require('lodash');
var fs = require('fs-extra');

var FileStore = function (rootDirectory) {
  var CONTENT_FILE = '.dummys3_content',
    METADATA_FILE = '.dummys3_metadata',
    Bucket = require('./models/bucket'),
    S3Object = require('./models/s3-object');
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
    fs.mkdirp(bucketPath, 502, function (err) {
      if (err) {
        return done(err);
      }
      return getBucket(bucketName, done);
    });
  };

  var getObject = function (bucket, key, range, done) {
    if (typeof range === 'function') {
      done = range;
      range = null;
    }
    var filePath = path.resolve(getBucketPath(bucket.name), key);
    fs.stat(filePath, function (err, stats) {
      if (err && err.code === 'ENOENT') {
        return done('Not found');
      }
      var options = {};
      if (range) {
        var positions = range.replace(/bytes=/, '').split('-');
        options.start = parseInt(positions[0], 10);
        if (positions[1]) options.end = parseInt(positions[1], 10);
      }
      async.parallel([
        function (callback) {
          var readStream = fs.createReadStream(path.join(filePath, CONTENT_FILE), options);
          readStream.range = range && options;
          readStream.on('error', function (err) {
            return callback(err);
          });
          readStream.on('open', function () {
            return callback(null, readStream);
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
    var objects = [];
    var commonPrefixes = [];
    var keys = utils.walk(bucketPath);

    if (keys.length === 0) {
      return done(null, {
        objects: [],
        commonPrefixes: []
      });
    }

    var filteredKeys = [];

    if (options.delimiter && options.prefix) {
      _.forEach(keys, function (key) {
        var truncatedKey = key.replace(bucketPath + "/", "");
        if (truncatedKey.slice(0, options.prefix.length) == options.prefix) {
          if (truncatedKey.indexOf(options.delimiter, options.prefix.length + 1) > -1) {
            var commonPrefix = truncatedKey.substring(0, truncatedKey.lastIndexOf(options.delimiter) + 1);
            if (commonPrefixes.indexOf(commonPrefix) == -1) {
              commonPrefixes.push(commonPrefix);
              commonPrefixes.sort();
            }
          } else {
            filteredKeys.push(key);
          }
        }
      });
    } else if (options.prefix) {
      _.forEach(keys, function (key) {
        var truncatedKey = key.replace(bucketPath + "/", "");
        if (truncatedKey.slice(0, options.prefix.length) == options.prefix) {
          filteredKeys.push(key);
        }
      });
    } else if (options.delimiter) {
      _.forEach(keys, function (key) {
        var truncatedKey = key.replace(bucketPath + "/", "");
        if (truncatedKey.indexOf(options.delimiter) > -1) {
          var commonPrefix = truncatedKey.substring(0, truncatedKey.indexOf(options.delimiter) + 1);
          if (commonPrefixes.indexOf(commonPrefix) == -1) {
            commonPrefixes.push(commonPrefix);
            commonPrefixes.sort();
          }
        } else {
          filteredKeys.push(key);
        }
      });

    } else {
      filteredKeys = keys;
    }

    filteredKeys.sort();
    if (options.marker) {
      var startAt = 0;
      var found = false;
      _.each(filteredKeys, function (key, index) {
        if (options.marker == key.replace(bucketPath + '/', '')) {
          startAt = index + 1;
          found = true;
        }
      });
      filteredKeys = (found) ? filteredKeys.slice(startAt) : [];
    }

    filteredKeys = filteredKeys.slice(0, options.maxKeys);

    async.eachSeries(filteredKeys, function (key, callback) {
      key = key.replace(/\\/g, '/');
      fs.readFile(path.join(key, METADATA_FILE), function (err, data) {
        if (!err) {
          objects.push(buildS3ObjectFromMetaDataFile(key.replace(bucketPath + '/', ''), data));
        }
        callback();
      });
    }, function () {
      return done(null, {
        objects: objects,
        commonPrefixes: commonPrefixes
      });
    });
  };

  var buildS3ObjectFromMetaDataFile = function (key, file) {
    var json = JSON.parse(file);
    var metaData = {
      key: key,
      md5: json.md5,
      contentType: json.contentType,
      contentEncoding: json.contentEncoding,
      contentDisposition: json.contentDisposition,
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
      type = data.type,
      encoding = data.encoding,
      disposition = data.disposition,
      metaFile = data.metaFile,
      headers = data.headers;
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
        var length = 0;
        var md5 = crypto.createHash('md5')
        var stream = fs.createReadStream(contentFile)

        stream.on('error', function (err) {
          return callback(err)
        });

        stream.on('data', function (data) {
          length += data.length;
          md5.update(data, 'utf8');
        });

        stream.on('end', function () {
          return callback(null, {
            size: length,
            md5: md5.digest('hex')
          });
        });
      }
    ], function (err, results) {
      var metaData = {
        md5: results[1].md5,
        size: results[1].size,
        modifiedDate: results[0].mtime,
        creationDate: results[0].ctime,
        customMetaData: getCustomMetaData(headers)
      };
      if (type)
        metaData.contentType = type;
      if (encoding)
        metaData.contentEncoding = encoding;
      if (disposition)
        metaData.contentDisposition = disposition;

      fs.writeFile(metaFile, JSON.stringify(metaData), function (err) {
        if (err) {
          return done(err);
        }
        return done(null, metaData);
      });
    });
  };

  var putObject = function (bucket, key, req, done) {
    var keyName = path.join(bucket.name, key);
    var dirName = path.join(rootDirectory, keyName);
    fs.mkdirpSync(dirName);
    var contentFile = path.join(dirName, CONTENT_FILE);
    var metaFile = path.join(dirName, METADATA_FILE);
    var key = req.params.key;
    var objectName = key;
    key = key.substr(key.lastIndexOf('/') + 1);
    var writeStream = req.pipe(fs.createWriteStream(contentFile));
    writeStream.on('error', function (err) {
      return done('Error writing file');
    });
    writeStream.on('finish', function () {
      writeStream.end();
      createMetaData({
        contentFile: contentFile,
        type: req.headers['content-type'],
        encoding: req.headers['content-encoding'],
        disposition: req.headers['content-disposition'],
        key: key,
        metaFile: metaFile,
        headers: req.headers
      }, function (err, metaData) {
        if (err) {
          return done('Error uploading file');
        }
        metaData.key = objectName;
        return done(null, new S3Object(metaData));
      });
    });
  };

  var copyObject = function (options, done) {

    var req = options.request,
      srcBucket = options.srcBucket,
      srcKey = options.srcKey,
      destKey = options.destKey,
      destBucket = options.destBucket,
      replaceMetadata = options.replaceMetadata || (srcKeyPath === destKeyPath),
      srcKeyPath = path.resolve(getBucketPath(srcBucket.name), srcKey),
      destKeyPath = path.resolve(getBucketPath(destBucket.name), destKey),
      srcMetadataFilePath = path.join(srcKeyPath, METADATA_FILE),
      srcContentFilePath = path.join(srcKeyPath, CONTENT_FILE),
      destMetadataFilePath = path.join(destKeyPath, METADATA_FILE),
      destContentFilePath = path.join(destKeyPath, CONTENT_FILE);

    if (srcKeyPath !== destKeyPath) {
      fs.mkdirpSync(destKeyPath);
      fs.copySync(srcContentFilePath, destContentFilePath);
    }

    if (replaceMetadata) {
      var originalObject =
        buildS3ObjectFromMetaDataFile(srcKey,
          fs.readFileSync(srcMetadataFilePath));
      createMetaData({
        contentFile: destContentFilePath,
        type: originalObject.contentType,
        encoding: originalObject.contentEncoding,
        disposition: originalObject.contentDisposition,
        key: srcKey,
        metaFile: destMetadataFilePath,
        headers: req.headers
      }, function (err, metaData) {
        if (err) {
          return done('Error updating metadata');
        }
        metaData.key = destKey;
        return done(null, new S3Object(metaData));
      });
    } else {
      fs.copySync(srcMetadataFilePath, destMetadataFilePath);
      fs.readFile(destMetadataFilePath, function (err, data) {
        if (err) {
          return done(err);
        }
        done(null, buildS3ObjectFromMetaDataFile(destKey, data));
      });
    }
  };

  var deleteObject = function (bucket, key, done) {
    var bucketPath = getBucketPath(bucket.name);
    var keyPath = path.resolve(bucketPath, key);
    async.map([path.join(keyPath, METADATA_FILE),
    path.join(keyPath, CONTENT_FILE)], fs.unlink, function (err) {
      if (err) {
        return done(err);
      }
      fs.rmdir(keyPath, function () {
        utils.removeEmptyDirectories(fs, bucketPath, function () {
          return done();
        });
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

  var concatStreams = function (passThrough, streams) {
    var stream = streams.shift();
    if (!stream) {
      passThrough.end();
      return passThrough;
    }
    stream.once('end', function () { concatStreams(passThrough, streams); });
    stream.pipe(passThrough, { end: false });
    return passThrough;
  };

  var combineObjectParts = function (bucket, key, uploadId, parts, req, done) {
    var sortedParts = _.sortBy(parts, function (part) { return part.number; });
    var partPaths = _.map(sortedParts, function (part) {
      return path.resolve(getBucketPath(bucket.name), uploadId + '_' + part.number);
    });
    var partStreams = _.map(partPaths, function (partPath) { return fs.createReadStream(path.join(partPath, CONTENT_FILE)); });
    var combinedPartsStream = concatStreams(new PassThrough(), partStreams);
    var keyName = path.join(bucket.name, key);
    var dirName = path.join(rootDirectory, keyName);
    fs.mkdirpSync(dirName);
    var contentFile = path.join(dirName, CONTENT_FILE);
    var metaFile = path.join(dirName, METADATA_FILE);
    var writeStream = combinedPartsStream.pipe(fs.createWriteStream(contentFile));
    writeStream.on('error', function (err) {
      return done(err);
    });
    writeStream.on('finish', function () {
      writeStream.end();
      _.forEach(partPaths, function (partPath) { fs.removeSync(partPath); });
      createMetaData({
        contentFile: contentFile,
        type: req.headers['content-type'],
        encoding: req.headers['content-encoding'],
        disposition: req.headers['content-disposition'],
        key: key,
        metaFile: metaFile,
        headers: req.headers
      }, function (err, metaData) {
        if (err) {
          return done(err);
        }
        return done(null, new S3Object(metaData));
      });
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
    deleteObject: deleteObject,
    combineObjectParts: combineObjectParts
  };
};
module.exports = FileStore;
