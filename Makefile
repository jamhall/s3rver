IMAGE_NAME?=jamhall/s3rver
IMAGE_TAG?=latest

.PHONY: lint
lint:
	npm run eslint
	npm run prettier-check

.PHONY: build
build:
	npm install

.PHONY: test
test:
	npm run test

.PHONY: start
start:
	nodejs ./bin/s3rver -d ./data

.PHONY: build_docker
build_docker:
	docker build -t ${IMAGE_NAME}:${IMAGE_TAG} .

.PHONY: push_docker
push_docker:
	docker build -t ${IMAGE_NAME}:${IMAGE_TAG} .

.PHONY: start_docker
start_docker:
	docker run -v $$PWD/data:/data -p 8080:8080 ${IMAGE_NAME}:${IMAGE_TAG}
