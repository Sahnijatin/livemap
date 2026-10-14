package com.example.data;

import androidx.annotation.NonNull;
import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.Ignore;

@Entity(tableName = "tags", primaryKeys = {"id"})
public class Tag {
    public long id;

    @NonNull
    @ColumnInfo(name = "label")
    public String name;

    public String color;

    @Ignore
    public int usage;

    public static final String KIND = "tag";

    public Tag(long id, @NonNull String name) {
        this.id = id;
        this.name = name;
    }
}
