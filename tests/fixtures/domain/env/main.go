package main

import "os"

func main() {
	_ = os.Getenv("GO_PORT")
	_, _ = os.LookupEnv("GO_HOST")
	// os.Getenv("GO_COMMENTED")
}
