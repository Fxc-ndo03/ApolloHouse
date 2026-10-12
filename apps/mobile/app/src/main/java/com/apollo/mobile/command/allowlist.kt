package com.apollo.mobile.command

import com.apollo.mobile.contract.Contract

/**
 * Allowlist explicita capability -> comando. No hay lookup dinamico: una capability
 * fuera de esta tabla se rechaza aunque exista en el catalogo del Worker
 * (BLOCK 11 §5 y §16).
 */
object CommandAllowlist {

    fun listCommandFor(capabilityName: String): List<String> =
        Contract.ALLOWED_COMMAND_MAP[capabilityName] ?: emptyList()

    fun isAllowed(capabilityName: String): Boolean =
        Contract.ALLOWED_COMMAND_MAP.containsKey(capabilityName)

    /** El peer sólo ejecuta un comando que su capability declare. */
    fun isCommandDeclaredByCapability(capabilityName: String, commandName: String): Boolean =
        Contract.ALLOWED_COMMAND_MAP[capabilityName]?.contains(commandName) == true
}
