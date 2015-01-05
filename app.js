'use strict';

var express = require('express'),
    app = express(),
    FileStore = require('./lib/file-store'),
    fileStore = new FileStore('/tmp/dummys3_root'),
    templateBuilder = require('./lib/xml-template-builder'),
    morgan = require('morgan'),
    multipart = require('connect-multiparty'),
    multipartMiddleware = multipart();

app.use(morgan('combined'));

app.get('/', function (req, res) {
  var buckets = fileStore.getAllBuckets();
  var xml = templateBuilder.buildBuckets(buckets);
  res.header('Content-Type', 'application/xml');
  return res.send(xml);
});

var buildXmlResponse = function (res, status, template) {
  res.header('Content-Type', 'application/xml');
  res.status(404);
  return res.send(template);
};

app.get('/:bucket', function (req, res) {
  var acl = req.query.acl;
  var bucketName = req.params.bucket;
  if (acl) {
    return res.send('Getting acl');
  } else {
    fileStore.getBucket(bucketName, function (err, bucket) {
      if (err) {
        var template = templateBuilder.buildBucketNotFound(bucketName);
        return buildXmlResponse(res, 404, template);
      }
      var options = {
        marker: req.query.marker || '',
        prefix: req.query.prefix || '',
        maxKeys: req.query['max-keys'] || 1000,
        delimiter: req.query.delimiter || null
      };
      fileStore.getAllKeysForBucket(bucket, options, function (err, keys) {
        var template = templateBuilder.buildBucketQuery(options, keys);
        return buildXmlResponse(res, 200, template);
      });
    });
  }
});

app.delete('/:bucket', function (req, res) {
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
});

app.put('/:bucket', function (req, res) {
  var bucketName = req.params.bucket;
  fileStore.getBucket(bucketName, function (err, bucket) {
    if (bucket) {
      var template = templateBuilder.buildBucketNotFound(bucketName);
      return buildXmlResponse(res, 404, template);
    }
    fileStore.createBucket(bucketName, function (err, bucket) {
      if (err) {
        return res.status(400).json('Error creating bucket');
      }
      return res.send(bucket);
    });
  });
});

app.put('/:bucket/:key(*)', multipartMiddleware, function (req, res) {
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
});

app.get('/:bucket/:key(*)', function (req, res) {
  var bucketName = req.params.bucket;
  var keyName = req.params.key;
  fileStore.getBucket(bucketName, function (err, bucket) {
    if (err) {
      var template = templateBuilder.buildBucketNotFound(bucketName);
      return buildXmlResponse(res, 404, template);
    }
    fileStore.getKey(bucket, keyName, function (err, key, data) {
      if (err) {
        var template = templateBuilder.buildKeyNotFound(keyName);
        return buildXmlResponse(res, 404, template);
      }
      res.header('Etag', key.md5);
      res.header('Content-Type', key.contentType);
      return res.status(200).end(data);
    });
  });
});

var server = app.listen(3000, function () {
  var host = server.address().address;
  var port = server.address().port;
  console.log('Example app listening at http://%s:%s', host, port);
});
