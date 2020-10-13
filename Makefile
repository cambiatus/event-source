.PHONY: help build

APP_VSN ?= `grep 'version' package.json | cut -d '"' -f4`
BUILD ?= `git rev-parse --short HEAD`
APP_NAME ?= event-source
IMAGE_NAME ?= bespiral/event-source

help:
	@echo "$(APP_NAME):$(APP_VSN)-$(BUILD)"
	@perl -nle'print $& if m{^[a-zA-Z_-]+:.*?## .*$$}' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'
