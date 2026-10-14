package com.example.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Ignore
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "orders",
    foreignKeys = [ForeignKey(entity = User::class, parentColumns = ["id"], childColumns = ["user_id"])],
    indices = [Index(value = ["code"], unique = true)]
)
data class Order(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    @ColumnInfo(name = "user_id") val userId: Long,
    val code: String,
    val note: String?,
    @Ignore val cached: Boolean = false,
) {
    var total: Double = 0.0
    val label: String get() = code
}

@Entity
data class User(
    @PrimaryKey val id: Long,
    val email: String
)

data class OrderWithUser(val order: Order, val user: User)
