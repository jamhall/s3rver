S3TEST_IMAGE=s3rver-s3tests

.PHONY: build_s3tests
build_s3tests:
	docker build -t ${S3TEST_IMAGE} ./contrib/s3tests

.PHONY: start_s3tests
start_s3tests:
	docker run --rm --network host ${S3TEST_IMAGE}
