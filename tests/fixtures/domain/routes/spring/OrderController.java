package com.shop.web;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @GetMapping
    public List<Order> list() { return service.all(); }

    @GetMapping("/{id}")
    public Order get(@PathVariable Long id) { return service.get(id); }

    @PostMapping(consumes = "application/json")
    @ResponseStatus(HttpStatus.CREATED)
    public Order create(@RequestBody Order o) { return o; }

    @RequestMapping(value = "/{id}/cancel", method = RequestMethod.POST)
    public void cancel(@PathVariable Long id) {}

    @RequestMapping(path = "/search", method = {RequestMethod.GET, RequestMethod.HEAD})
    public List<Order> search() { return null; }

    // @DeleteMapping("/{id}/old")
    @DeleteMapping(value = "/{id}")
    public void delete(@PathVariable Long id) {}
}
