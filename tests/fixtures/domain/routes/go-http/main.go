package main

import (
	"fmt"
	"net/http"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /orders/{id}", getOrder)
	mux.HandleFunc("POST /orders", createOrder)
	mux.Handle("/static/", http.StripPrefix("/static/", fs))
	mux.HandleFunc("DELETE /files/{path...}", deleteFile)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	// mux.HandleFunc("GET /commented", h)
	resp, _ := http.Get("/x")
	_ = resp
	http.ListenAndServe(":8080", mux)
}
