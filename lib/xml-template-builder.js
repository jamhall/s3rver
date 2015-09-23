'use strict';
var xml = function () {
  var jstoxml = require('jstoxml');
  var _ = require('lodash');
  var DISPLAY_NAME = 'S3rver';
  var buildQueryContentXML = function (data, options) {
    var content = _.map(data.objects, function (item) {
      return {
        Contents: {
          Key: item.key,
          LastModified: item.modifiedDate,
          ETag: item.md5,
          Size: item.size,
          StorageClass: 'Standard',
          Owner: {
            ID: 123,
            DisplayName: DISPLAY_NAME
          }
        }
      };
    });
    content = content.concat(_.map(data.commonPrefixes, function(prefix) {
      return {
        CommonPrefixes: {Prefix: prefix}
      };
    }));
    content.unshift({
      Name: options.bucketName,
      Prefix: options.prefix || '',
      Marker: options.marker || '',
      MaxKeys: options.maxKeys,
      IsTruncated: false
    });
    return content;
  };
  return {
    buildBuckets: function (buckets) {
      return jstoxml.toXML({
        _name: 'ListAllMyBucketsResult',
        _attrs: {'xmlns': 'http://doc.s3.amazonaws.com/2006-03-01'},
        _content: {
          Owner: {
            ID: 123,
            DisplayName: DISPLAY_NAME
          },
          Buckets: _.map(buckets, function (bucket) {
            return {
              Bucket: {
                Name: bucket.name,
                CreationDate: bucket.creationDate.toISOString()
              }
            };
          })
        }
      }, {
        header: true,
        indent: '  '
      });
    },
    buildBucketQuery: function (options, data) {
      var xml = {
        _name: 'ListAllMyBucketsResult',
        _attrs: {'xmlns': 'http://doc.s3.amazonaws.com/2006-03-01'},
        _content: buildQueryContentXML(data, options)
      };
      return jstoxml.toXML(xml, {
        header: true,
        indent: '  '
      });
    },
    buildBucketNotFound: function (bucketName) {
      return jstoxml.toXML({
        Error: {
          Code: 'NoSuchBucket',
          Message: 'The resource you requested does not exist',
          Resource: bucketName,
          RequestId: 1
        }
      }, {
        header: true,
        indent: '  '
      });
    },
    buildBucketNotEmpty: function (bucketName) {
      return jstoxml.toXML({
        Error: {
          Code: 'BucketNotEmpty',
          Message: 'The bucket your tried to delete is not empty',
          Resource: bucketName,
          RequestId: 1,
          HostId: 2
        }
      }, {
        header: true,
        indent: '  '
      });
    },
    buildKeyNotFound: function (key) {
      return jstoxml.toXML({
        Error: {
          Code: 'NoSuchKey',
          Message: 'The specified key does not exist',
          Resource: key,
          RequestId: 1
        }
      }, {
        header: true,
        indent: '  '
      });
    },
    buildError: function (code, message) {
      return jstoxml.toXML({
        Error: {
          Code: code,
          Message: message,
          RequestId: 1
        }
      }, {
        header: true,
        indent: '  '
      });
    },
    buildAcl: function () {
      return jstoxml.toXML({
        _name: 'AccessControlPolicy',
        _attrs: {'xmlns': 'http://doc.s3.amazonaws.com/2006-03-01'},
        _content: {
          Owner: {
            ID: 123,
            DisplayName: DISPLAY_NAME
          },
          AccessControlList: {
            Grant: {
              _name: 'Grantee',
              _attrs: {
                'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
                'xsi:type': 'CanonicalUser'
              },
              _content: {
                ID: 'abc',
                DisplayName: 'You'
              }
            },
            Permission: 'FULL_CONTROL'
          }
        }
      }, {
        header: true,
        indent: '  '
      });
    },
    buildCopyObject: function (item) {
      return jstoxml.toXML({
        CopyObjectResult: {
          LastModified: item.modifiedDate,
          ETag: item.md5
        }
      }, {
        header: true,
        indent: '  '
      });
    }
  };
};
module.exports = xml();
