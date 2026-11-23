package io.github.tyanochkuby.androidagent.tasks

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

internal val taskJson = Json { encodeDefaults = true }

@Serializable
internal data class ConversationTurn(val id: String, val prompt: String, val reply: String?)

internal class TaskJournal(context: Context) : SQLiteOpenHelper(context, "tasks.db", null, 2), TaskStore {
  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      "CREATE TABLE tasks (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL)",
    )
    createConversationTable(db)
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    check(oldVersion == 1 && newVersion == 2) { "No task journal migration from $oldVersion to $newVersion." }
    createConversationTable(db)
  }

  private fun createConversationTable(db: SQLiteDatabase) {
    db.execSQL(
      "CREATE TABLE conversation (sequence INTEGER PRIMARY KEY, prompt TEXT NOT NULL, reply TEXT)",
    )
  }

  suspend fun readConversation(): List<ConversationTurn> = withContext(Dispatchers.IO) {
    readableDatabase.rawQuery(
      "SELECT sequence, prompt, reply FROM conversation ORDER BY sequence",
      null,
    ).use { cursor ->
      buildList {
        while (cursor.moveToNext()) {
          add(ConversationTurn(cursor.getString(0), cursor.getString(1), cursor.getString(2)))
        }
      }
    }
  }

  suspend fun startTurn(prompt: String): String = withContext(Dispatchers.IO) {
    require(prompt.isNotBlank() && prompt.length <= 2_000) { "Invalid conversation prompt." }
    val db = writableDatabase
    val values = ContentValues().apply { put("prompt", prompt) }
    db.beginTransaction()
    try {
      val id = db.insertOrThrow("conversation", null, values)
      db.execSQL(
        "DELETE FROM conversation WHERE sequence <= " +
          "(SELECT sequence FROM conversation ORDER BY sequence DESC LIMIT 1 OFFSET 50)",
      )
      db.setTransactionSuccessful()
      id.toString()
    } finally {
      db.endTransaction()
    }
  }

  suspend fun saveReply(id: String, reply: String): Unit = withContext(Dispatchers.IO) {
    require(reply.isNotBlank() && reply.length <= 2_000) { "Invalid conversation reply." }
    val values = ContentValues().apply { put("reply", reply) }
    check(writableDatabase.update("conversation", values, "sequence = ?", arrayOf(id)) == 1) {
      "The conversation prompt is unavailable."
    }
  }

  override suspend fun read(id: String?): Task? = withContext(Dispatchers.IO) {
    val query = if (id == null) "SELECT snapshot FROM tasks ORDER BY sequence DESC LIMIT 1"
    else "SELECT snapshot FROM tasks WHERE id = ?"
    readableDatabase.rawQuery(query, id?.let { arrayOf(it) }).use { cursor ->
      if (cursor.moveToFirst()) taskJson.decodeFromString<Task>(cursor.getString(0)) else null
    }
  }

  override suspend fun save(task: Task): Unit = withContext(Dispatchers.IO) {
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
