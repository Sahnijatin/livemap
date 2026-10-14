package com.shop.web

@RestController
@RequestMapping(value = ["/users"])
class UserController(private val repo: UserRepository) {

    @GetMapping("/{id}")
    fun get(@PathVariable id: Long): User = repo.find(id)

    @PutMapping(path = ["/{id}", "/{id}/profile"])
    suspend fun update(@PathVariable id: Long, @RequestBody u: User): User = u

    @RequestMapping("/export")
    fun export(): String = ""
}

class Plain {
    @GetMapping("/plain")
    fun plain() = Unit
}
