package main

import "github.com/gin-gonic/gin"

func main() {
	r := gin.Default()
	r.GET("/ping", ping)
	api := r.Group("/api")
	v1 := api.Group("/v1")
	{
		v1.GET("/orders/:id", handlers.GetOrder)
		v1.POST("/orders", handlers.CreateOrder)
	}
	api.DELETE("/orders/:id", func(c *gin.Context) {})
	r.Any("/proxy/*path", proxy)
	r.Run()
}

func register(rg *gin.RouterGroup) {
	rg.PUT("/settings", saveSettings)
}
