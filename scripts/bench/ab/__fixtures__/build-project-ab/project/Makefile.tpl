.PHONY: build test vet clean

build:
	go build -o bin/logstat ./cmd/logstat

test:
	go test ./...

vet:
	go vet ./...

clean:
	rm -rf bin
