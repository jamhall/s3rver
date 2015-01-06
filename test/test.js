var knox = require('knox');
var AWS = require('aws-sdk');
var async = require('async');
var should = require('should');
var fs = require('fs-extra');
var _ = require('lodash');
var moment = require('moment');
var Chance = require('chance');
var chance = new Chance();

describe('S3Server Tests', function () {
  var s3Client;
  var buckets = ['bucket1', 'bucket2', 'bucket3', 'bucket4', 'bucket5'];
  before(function (done) {
    var config = {
      accessKeyId: "123",
      secretAccessKey: "abc",
      endpoint: "localhost:3000",
      sslEnabled: false,
      s3ForcePathStyle: true
    };
    AWS.config.update(config);
    s3Client = new AWS.S3();
    s3Client.endpoint = new AWS.Endpoint(config.endpoint);
    /**
     * Make the temporary directory
     */
    fs.remove('/tmp/dummys3_root', function (err) {
      fs.mkdirs('/tmp/dummys3_root', function (err) {
        if (err) return console.error(err)
        done();
      });
    });
  });
  it('should successfully connect to the server', function (done) {

    done();
  });

  it('should create five buckets', function (done) {
    async.eachSeries(buckets, function (bucket, callback) {
      s3Client.createBucket({Bucket: bucket}, function (err) {
        if (err) {
          return callback(err);
        }
        callback(null);
      });
    }, function (err) {
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should fetch fetch five buckets', function (done) {
    s3Client.listBuckets(function (err, buckets) {
      if (err) return done(err);
      buckets.Buckets.length.should.equal(5);
      _.forEach(buckets.Buckets, function (bucket) {
        bucket.Name.should.be.ok;
        moment(bucket.CreationDate).isValid().should.equal(true);
      });
      done();
    });
  });

  it('should fail to create a bucket because of invalid name', function (done) {
    s3Client.createBucket({Bucket: '-$%!nvalid'}, function (err) {
      err.statusCode.should.equal(400);
      err.code.should.equal('InvalidBucketName');
      should.exist(err);
      done();
    });
  });

  it('should fail to create a bucket because name is too long', function (done) {
    s3Client.createBucket({Bucket: chance.string({length: 64, pool: 'abcd'})}, function (err) {
      err.statusCode.should.equal(400);
      err.code.should.equal('InvalidBucketName');
      should.exist(err);
      done();
    });
  });

  it('should fail to create a bucket because name is too short', function (done) {
    s3Client.createBucket({Bucket: 'ab' }, function (err) {
      err.statusCode.should.equal(400);
      err.code.should.equal('InvalidBucketName');
      should.exist(err);
      done();
    });
  });

  it('should delete a bucket', function (done) {
    s3Client.deleteBucket({ Bucket: buckets[4] }, function (err) {
      if (err) return done(err);
      return done();
    });
  });

  it('should not fetch the deleted bucket', function (done) {
    s3Client.listObjects({ Bucket: buckets[4] }, function (err) {
      err.code.should.equal('NoSuchBucket');
      err.statusCode.should.equal(404);
      done();
    });
  });

  it('should store an object in a bucket', function (done) {
    done();
  });
  after(function (done) {
    fs.remove('/tmp/dummys3_root', function (err) {
      if (err) return console.error(err)
      done();
    });
    done();
  });

});
