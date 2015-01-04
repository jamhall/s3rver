var xml = function () {
  var jstoxml = require('jstoxml');
  var _ = require('lodash');
  var buildQueryContentXML = function (items, options) {
    var content = _.map(items, function (item) {
      return {
        Contents: {
          Key: item.key,
          LastModified: item.creationDate,
          ETag: item.md5,
          Size: item.size,
          StorageClass: 'Standard',
          Owner: {
            ID: 123,
            DisplayName: 'DummyS3'
          }
        }
      };
    });
    content.unshift({
      Name: options.bucketName,
      Prefix: options.prefix,
      Marker: options.marker,
      MaxKeys: options.maxKeys,
      IsTruncated: false
    });
    return content;
  };
  return {
    buildBucketsXml: function (buckets) {
      var xml = jstoxml.toXML({
        _name: 'ListAllMyBucketsResult',
        _attrs: { 'xmlns': 'http://doc.s3.amazonaws.com/2006-03-01' },
        _content: {
          Owner: {
            ID: 123,
            DisplayName: 'DummyS3'
          },
          Buckets: _.map(buckets, function (bucket) {
            return { Bucket: bucket };
          })
        }
      }, {
        header: true,
        indent: '  '
      });
      return xml;
    },
    buildBucketQueryXml: function (options, items) {
      var xml = {
        _name: 'ListAllMyBucketsResult',
        _attrs: { 'xmlns': 'http://doc.s3.amazonaws.com/2006-03-01' },
        _content: buildQueryContentXML(items, options)
      };
      return jstoxml.toXML(xml, {
        header: true,
        indent: '  '
      });
    },
    buildBucketNotFoundXml: function (bucketName) {
      var xml = jstoxml.toXML({
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
      return xml;
    },
    buildBucketNotEmptyXml: function (bucketName) {
      var xml = jstoxml.toXML({
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
      return xml;
    },
    buildKeyNotFoundXml: function (key) {
      var xml = jstoxml.toXML({
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
      return xml;
    },
    buildAclXml: function () {
      var xml = jstoxml.toXML({
        _name: 'AccessControlPolicy',
        _attrs: { 'xmlns': 'http://doc.s3.amazonaws.com/2006-03-01' },
        _content: {
          Owner: {
            ID: 123,
            DisplayName: 'DummyS3'
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
      return xml;
    }
  };
};
module.exports = xml();