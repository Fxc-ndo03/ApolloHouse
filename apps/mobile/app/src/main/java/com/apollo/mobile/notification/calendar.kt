package com.apollo.mobile.notification

import android.content.ContentValues
import android.content.Context
import android.provider.CalendarContract

/**
 * BLOCK 12.5.1: las operaciones de calendario, fuera de `AndroidMobilePlatform`.
 *
 * No es una division estetica. `AndroidMobilePlatform` estaba pasando las 300
 * lineas del limite del proyecto porque llevaba cinco concerns distintos
 * —alarma, calendario, multimedia, volumen y abrir app—. El calendario es el
 * unico que depende de un proveedor de contenido del sistema (`ContentResolver`
 * contra `CalendarContract`) en vez de la plataforma local, asi que es el que
 * mas se prestaba a mudarse de archivo.
 *
 * Mismo comportamiento exacto que antes: los mismos valores por defecto y los
 * mismos `catch`.
 */
class AndroidCalendarGateway(
    private val context: Context
) {

    fun createEvent(title: String, startsAt: String, location: String): Boolean {
        val startTime = parseIsoLocalDateTime(startsAt) ?: return false
        val values = ContentValues().apply {
            put(CalendarContract.Events.TITLE, title)
            put(CalendarContract.Events.DTSTART, startTime)
            put(CalendarContract.Events.DTEND, startTime + DEFAULT_EVENT_DURATION_MILLISECONDS)
            put(CalendarContract.Events.EVENT_TIMEZONE, java.util.TimeZone.getDefault().id)
            if (location.isNotEmpty()) {
                put(CalendarContract.Events.EVENT_LOCATION, location)
            }
        }
        val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
        return uri != null
    }

    fun deleteEventByTitle(title: String): Boolean {
        val deletedCount = context.contentResolver.delete(
            CalendarContract.Events.CONTENT_URI,
            "${CalendarContract.Events.TITLE} = ?",
            arrayOf(title)
        )
        return deletedCount > 0
    }

    fun listEvents(withinDays: Int): List<CalendarEventSummary> {
        val windowStart = System.currentTimeMillis()
        val windowEnd = windowStart + withinDays * 24L * 60L * 60L * 1000L
        val projectionList = arrayOf(
            CalendarContract.Events.TITLE,
            CalendarContract.Events.DTSTART,
            CalendarContract.Events.EVENT_LOCATION
        )
        val selectionList = arrayOf(
            "${CalendarContract.Events.DTSTART} >= ?",
            "${CalendarContract.Events.DTSTART} < ?"
        )
        val selectionArgumentList = arrayOf(windowStart.toString(), windowEnd.toString())
        val eventSummaryList = mutableListOf<CalendarEventSummary>()
        try {
            context.contentResolver.query(
                CalendarContract.Events.CONTENT_URI,
                projectionList,
                selectionList.joinToString(" AND "),
                selectionArgumentList,
                "${CalendarContract.Events.DTSTART} ASC"
            )?.use { cursor ->
                val titleIndex = cursor.getColumnIndexOrThrow(CalendarContract.Events.TITLE)
                val startIndex = cursor.getColumnIndexOrThrow(CalendarContract.Events.DTSTART)
                val locationIndex =
                    cursor.getColumnIndexOrThrow(CalendarContract.Events.EVENT_LOCATION)
                while (cursor.moveToNext()) {
                    eventSummaryList.add(
                        CalendarEventSummary(
                            title = cursor.getString(titleIndex) ?: "",
                            startsAt = formatIsoLocalDateTime(cursor.getLong(startIndex)),
                            location = cursor.getString(locationIndex) ?: ""
                        )
                    )
                }
            }
        } catch (deniedBySystem: SecurityException) {
            return emptyList()
        }
        return eventSummaryList
    }

    private fun formatIsoLocalDateTime(epochMilliseconds: Long): String =
        java.text.SimpleDateFormat(ISO_LOCAL_DATE_TIME_PATTERN, java.util.Locale.US)
            .format(java.util.Date(epochMilliseconds))

    private fun parseIsoLocalDateTime(rawValue: String): Long? = try {
        java.text.SimpleDateFormat(ISO_LOCAL_DATE_TIME_PATTERN, java.util.Locale.US)
            .parse(rawValue)
            ?.time
    } catch (unparseable: java.text.ParseException) {
        null
    }

    companion object {
        const val DEFAULT_EVENT_DURATION_MILLISECONDS = 60L * 60L * 1000L
        private const val ISO_LOCAL_DATE_TIME_PATTERN = "yyyy-MM-dd'T'HH:mm:ss"
    }
}
