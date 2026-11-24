package io.github.tyanochkuby.androidagent.tasks

import android.content.ContentValues
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

private const val MAX_TEXT = 2_000

@Serializable
enum class TurnStatus { RUNNING, COMPLETED, FAILED, INTERRUPTED }

@Serializable
data class Turn(
  val id: String,
  val prompt: String,
  val reply: String?,
  val status: TurnStatus,
  val detail: String?,
  val taskIds: List<String>,
)

/** A model-written summary of every completed turn up to and including [covers]. */
@Serializable
data class Checkpoint(val summary: String, val covers: String)

/** Creates the conversation tables in the task database and copies rows from the earlier `conversation` table, which stays for rollback. */
internal fun createConversationSchema(db: SQLiteDatabase) {
  db.execSQL(
    "CREATE TABLE IF NOT EXISTS turns (sequence INTEGER PRIMARY KEY, prompt TEXT NOT NULL, reply TEXT, " +
      "status TEXT NOT NULL, detail TEXT, legacy_sequence INTEGER UNIQUE)",
  )
  db.execSQL("CREATE TABLE IF NOT EXISTS turn_tasks (turn INTEGER NOT NULL, task TEXT NOT NULL, PRIMARY KEY (turn, task))")
  db.execSQL("CREATE TABLE IF NOT EXISTS checkpoints (sequence INTEGER PRIMARY KEY, summary TEXT NOT NULL, covers INTEGER NOT NULL)")
  if (DatabaseUtils.queryNumEntries(db, "sqlite_master", "type = 'table' AND name = 'conversation'") == 0L) return
  db.execSQL(
    "INSERT INTO turns (prompt, reply, status, detail, legacy_sequence) " +
      "SELECT prompt, reply, CASE WHEN reply IS NULL THEN 'INTERRUPTED' ELSE 'COMPLETED' END, " +
      "CASE WHEN reply IS NULL THEN 'Imported without a saved reply.' END, sequence FROM conversation " +
      "WHERE sequence NOT IN (SELECT legacy_sequence FROM turns WHERE legacy_sequence IS NOT NULL) ORDER BY sequence",
  )
}

/** Links a new task to its running turn within the task insert transaction. */
internal fun linkTaskToTurn(db: SQLiteDatabase, turn: String, task: String) {
  check(DatabaseUtils.queryNumEntries(db, "turns", "sequence = ? AND status = 'RUNNING'", arrayOf(turn)) == 1L) {
    "This prompt is no longer running."
  }
  val values = ContentValues().apply {
    put("turn", turn)
    put("task", task)
  }
  db.insertOrThrow("turn_tasks", null, values)
}


/**
 * Device-local prompts, replies and turn status. Actions stay in the task journal; a turn only records the IDs of
 * tasks submitted while it ran.
 */
internal class Conversation(private val database: SQLiteOpenHelper) {
  suspend fun start(prompt: String, recoverUnacknowledged: Boolean): String = write { db ->
    require(prompt.isNotBlank() && prompt.length <= MAX_TEXT) { "Invalid prompt." }
    if (recoverUnacknowledged) {
      val values = ContentValues().apply { put("status", TurnStatus.INTERRUPTED.name) }
      db.update("turns", values, "status = 'RUNNING'", null)
    }
    check(DatabaseUtils.queryNumEntries(db, "turns", "status = 'RUNNING'") == 0L) { "Finish the current prompt first." }
    val values = ContentValues().apply {
      put("prompt", prompt)
      put("status", TurnStatus.RUNNING.name)
    }
    db.insertOrThrow("turns", null, values).toString()
  }

  suspend fun complete(id: String, reply: String) = finish(id, TurnStatus.COMPLETED, "reply", reply)

  suspend fun fail(id: String, detail: String) = finish(id, TurnStatus.FAILED, "detail", detail)

  /** Marks turns left running by an earlier JavaScript runtime. Their prompts are never replayed. */
  suspend fun interruptRunning(): Unit = write { db ->
    val values = ContentValues().apply { put("status", TurnStatus.INTERRUPTED.name) }
    db.update("turns", values, "status = 'RUNNING'", null)
  }

  /** Returns up to [limit] turns, newest first, starting below the turn [before]. */
  suspend fun read(before: String?, limit: Int): List<Turn> = withContext(Dispatchers.IO) {
    val db = database.readableDatabase
    require(before == null || DatabaseUtils.queryNumEntries(db, "turns", "sequence = ?", arrayOf(before)) == 1L) {
      "Unknown conversation turn."
    }
    val older = if (before == null) "" else "WHERE sequence < ? "
    val turns = db.rawQuery(
      "SELECT sequence, prompt, reply, status, detail FROM turns ${older}ORDER BY sequence DESC LIMIT ?",
      listOfNotNull(before, limit.toString()).toTypedArray(),
    ).use { cursor ->
      buildList {
        while (cursor.moveToNext()) {
          add(
            Turn(
              cursor.getString(0), cursor.getString(1), cursor.getString(2),
              TurnStatus.valueOf(cursor.getString(3)), cursor.getString(4), emptyList(),
            ),
          )
        }
      }
    }
    if (turns.isEmpty()) return@withContext turns
    val tasks = db.rawQuery(
      "SELECT turn, task FROM turn_tasks WHERE turn BETWEEN ? AND ? ORDER BY rowid",
      arrayOf(turns.last().id, turns.first().id),
    ).use { cursor ->
      buildList { while (cursor.moveToNext()) add(cursor.getString(0) to cursor.getString(1)) }
    }.groupBy({ it.first }, { it.second })
    turns.map { it.copy(taskIds = tasks[it.id].orEmpty()) }
  }

  /** Returns up to [limit] completed turns, oldest first, starting above the turn [after]. */
  suspend fun readCompleted(after: String?, limit: Int): List<Turn> = withContext(Dispatchers.IO) {
    database.readableDatabase.rawQuery(
      "SELECT sequence, prompt, reply FROM turns WHERE status = 'COMPLETED' AND sequence > ? ORDER BY sequence LIMIT ?",
      arrayOf(after ?: "0", limit.toString()),
    ).use { cursor ->
      buildList {
        while (cursor.moveToNext()) {
          add(Turn(cursor.getString(0), cursor.getString(1), cursor.getString(2), TurnStatus.COMPLETED, null, emptyList()))
        }
      }
    }
  }

  /** Returns the latest checkpoint. Earlier ones stay for reference. */
  suspend fun readCheckpoint(): Checkpoint? = withContext(Dispatchers.IO) {
    database.readableDatabase.rawQuery("SELECT summary, covers FROM checkpoints ORDER BY sequence DESC LIMIT 1", null)
      .use { cursor -> if (cursor.moveToFirst()) Checkpoint(cursor.getString(0), cursor.getString(1)) else null }
  }

  /** Stores a summary and its coverage together. Coverage must be a completed turn after the current checkpoint's. */
  suspend fun saveCheckpoint(summary: String, covers: String): Unit = write { db ->
    require(summary.isNotBlank() && summary.length <= MAX_TEXT) { "Invalid summary." }
    check(DatabaseUtils.queryNumEntries(db, "turns", "sequence = ? AND status = 'COMPLETED'", arrayOf(covers)) == 1L) {
      "The summary must end at a completed turn."
    }
    val covered = DatabaseUtils.longForQuery(db, "SELECT COALESCE(MAX(covers), 0) FROM checkpoints", null)
    check(covers.toLong() > covered) { "The summary is older than the current one." }
    val values = ContentValues().apply {
      put("summary", summary)
      put("covers", covers.toLong())
    }
    db.insertOrThrow("checkpoints", null, values)
  }

  // Repeating a finish that already landed succeeds, so a caller can retry after an unacknowledged write.
  private suspend fun finish(id: String, status: TurnStatus, column: String, text: String): Unit = write { db ->
    require(text.isNotBlank() && text.length <= MAX_TEXT) { "Invalid conversation text." }
    val values = ContentValues().apply {
      put("status", status.name)
      put(column, text)
    }
    if (db.update("turns", values, "sequence = ? AND status = 'RUNNING'", arrayOf(id)) == 1) return@write
    check(
      DatabaseUtils.queryNumEntries(db, "turns", "sequence = ? AND status = ? AND $column = ?", arrayOf(id, status.name, text)) == 1L,
    ) { "This prompt is no longer running." }
  }

  private suspend fun <T> write(block: (SQLiteDatabase) -> T): T = withContext(Dispatchers.IO) {
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      block(db).also { db.setTransactionSuccessful() }
    } finally {
      db.endTransaction()
    }
  }
}
