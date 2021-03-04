'use strict';

const crypto = require('crypto');

const { randomHexString } = require('../utils');

class S3Event {
  constructor(eventData, reqParams) {
    const { reqHeaders, sourceIp } = reqParams;
    let eventName = '';
    const s3Object = {
      key: eventData.S3Item.key,
      sequencer: Date.now().toString(16).toUpperCase(),
    };
    switch (eventData.eventType) {
      case 'Copy':
        eventName = 'ObjectCreated:Copy';
        s3Object.size = eventData.S3Item.size;
        break;

      case 'Put':
        eventName = 'ObjectCreated:Put';
        s3Object.size = eventData.S3Item.size;
        s3Object.eTag = JSON.parse(eventData.S3Item.metadata.etag);
        break;

      case 'Post':
        eventName = 'ObjectCreated:Post';
        s3Object.size = eventData.S3Item.size;
        s3Object.eTag = JSON.parse(eventData.S3Item.metadata.etag);
        break;

      case 'Delete':
        eventName = 'ObjectRemoved:Delete';
        break;
    }

    return {
      Records: [
        {
          eventVersion: '2.0',
          eventSource: 'aws:s3',
          awsRegion: 'us-east-1',
          eventTime: new Date().toISOString(),
          eventName: eventName,
          userIdentity: {
            principalId: 'AWS:' + randomHexString(21).toUpperCase(),
          },
          requestParameters: {
            sourceIPAddress: sourceIp,
          },
          responseElements: {
            'x-amz-request-id': randomHexString(16).toUpperCase(),
            'x-amz-id-2': crypto
              .createHash('sha256')
              .update(reqHeaders.host)
              .digest('base64'),
          },
          s3: {
            s3SchemaVersion: '1.0',
            configurationId: 'testConfigId',
            bucket: {
              name: eventData.bucket,
              ownerIdentity: {
                principalId: randomHexString(14).toUpperCase(),
              },
              arn: 'arn:aws:s3: : :' + eventData.bucket,
            },
            object: s3Object,
          },
        },
      ],
    };
  }
}

module.exports = S3Event;
