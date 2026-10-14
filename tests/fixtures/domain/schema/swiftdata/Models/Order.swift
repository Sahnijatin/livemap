import Foundation
import SwiftData

@Model
final class Order {
    @Attribute(.unique) var code: String
    var id: UUID
    var note: String?
    var items: [Item] = []
    var user: User?
    let createdAt: Date
    @Transient var draft: Bool = false
    var total: Double {
        items.reduce(0) { $0 + $1.price }
    }
    @Relationship(deleteRule: .cascade) var payments: [Payment] = []
    var tags: [String] = []
    static let kind = "order"

    init(code: String) {
        self.code = code
        self.id = UUID()
        self.createdAt = .now
    }
}

@Model
class Item {
    var price: Double = 0
    var order: Order?
}

@Model
final class User {
    var name: String
}

struct OrderSummary {
    var code: String
}
