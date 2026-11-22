package io.github.tyanochkuby.androidagent.tasks

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.serialization.json.Json

internal val taskJson = Json { encodeDefaults = true }

internal class TaskJournal(context: Context) : SQLiteOpenHelper(context, "tasks.db", null, 1) {
  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      "CREATE TABLE tasks (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL)",
    )
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    error("No task journal migration from $oldVersion to $newVersion.")
  }

  fun read(id: String? = null): Task? {
    val query = if (id == null) "SELECT snapshot FROM tasks ORDER BY sequence DESC LIMIT 1"
    else "SELECT snapshot FROM tasks WHERE id = ?"
    return readableDatabase.rawQuery(query, id?.let { arrayOf(it) }).use { cursor ->
      if (cursor.moveToFirst()) taskJson.decodeFromString<Task>(cursor.getString(0)) else null
    }
  }

  fun save(task: Task) {
    val snapshot = ContentValues().apply {
      put("snapshot", taskJson.encodeToString(task))
    }
    val db = writableDatabase
    if (db.update("tasks", snapshot, "id = ?", arrayOf(task.request.id)) == 0) {
      snapshot.put("id", task.request.id)
      db.insertOrThrow("tasks", null, snapshot)
    }
  }
}
