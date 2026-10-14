package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Get("/", home)
	r.Route("/api", func(r chi.Router) {
		r.Get("/orders", listOrders)
		r.Route("/orders/{orderID}", func(r chi.Router) {
			r.Get("/", getOrder)
			r.With(auth).Delete("/", deleteOrder)
		})
		r.Post("/orders", createOrder)
	})
	r.HandleFunc("/ws", ws)
	r.Method("PATCH", "/legacy", legacy)
	http.ListenAndServe(":3000", r)
}
