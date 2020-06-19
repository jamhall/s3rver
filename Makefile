S3TEST_IMAGE=s3rver-s3test

.PHONY: s3test
s3test:
	docker build -t ${S3TEST_IMAGE} ./contrib/s3test
	docker run --rm --network host ${S3TEST_IMAGE}
