.PHONY: build-WebhookFunction

# SAM provides ARTIFACTS_DIR. Bundle only the Lambda entry point and its imports.
build-WebhookFunction:
	mkdir -p "$(ARTIFACTS_DIR)"
	npm run build:serverless -- --outdir="$(ARTIFACTS_DIR)"
