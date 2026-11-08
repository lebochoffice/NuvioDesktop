package com.nuvio.app.features.simkl

import co.touchlab.kermit.Logger
import com.nuvio.app.isDesktop
import com.nuvio.app.features.tracking.TrackingAuthProvider
import com.nuvio.app.features.tracking.TrackingCapability
import com.nuvio.app.features.tracking.TrackingProviderDescriptor
import com.nuvio.app.features.tracking.TrackingProviderId
import com.nuvio.app.features.tracking.TrackingProviderRegistry
import com.nuvio.app.features.tracking.TrackingRefreshIntent
import com.nuvio.app.features.profiles.ProfileRepository
import kotlinx.atomicfu.locks.SynchronizedObject
import kotlinx.atomicfu.locks.synchronized
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

object SimklAuthRepository : TrackingAuthProvider {
    private val log = Logger.withTag("SimklAuth")
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val authorizationMutex = Mutex()
    private val refreshMutex = Mutex()
    private val stateLock = SynchronizedObject()
    private val deviceAuth by lazy { SimklDeviceAuthorization(SimklConfig.CLIENT_ID) }

    private val _uiState = MutableStateFlow(SimklAuthUiState())
    val uiState: StateFlow<SimklAuthUiState> = _uiState.asStateFlow()

    private val _isAuthenticated = MutableStateFlow(false)
    override val isAuthenticated: StateFlow<Boolean> = _isAuthenticated.asStateFlow()

    override val descriptor = TrackingProviderDescriptor(
        id = TrackingProviderId.SIMKL,
        displayName = "Simkl",
        capabilities = setOf(
            TrackingCapability.AUTHENTICATION,
            TrackingCapability.LIBRARY_READ,
            TrackingCapability.LIBRARY_WRITE,
            TrackingCapability.WATCHED_READ,
            TrackingCapability.WATCHED_WRITE,
            TrackingCapability.PROGRESS_READ,
            TrackingCapability.PROGRESS_WRITE,
            TrackingCapability.SCROBBLE,
        ),
    )

    private var hasLoaded = false
    private var profileGeneration = 0L
    private var storedState = SimklStoredAuthState()
    private var accessToken: String? = null
    private var devicePollingJob: Job? = null
    private var deviceSession: SimklV2Session? = null
    private var deviceProfileId = 0
    private var pendingDevice: SimklDeviceCode? = null
    private var deviceExpiresAt: Long? = null
    private var refreshRetryAfter = 0L
    private var refreshing: DeviceRefresh? = null

    private class DeviceRefresh(val profileId: Int, val session: SimklV2Session) {
        var disconnectRequested = false
    }

    init {
        TrackingProviderRegistry.register(this)
    }

    override fun ensureLoaded(): Unit = synchronized(stateLock) {
        if (hasLoaded && (!isDesktop || deviceProfileId == ProfileRepository.activeProfileId)) return
        loadFromDisk()
    }

    override fun onProfileChanged(): Unit = synchronized(stateLock) {
        loadFromDisk()
    }

    override fun clearLocalState(): Unit = synchronized(stateLock) {
        devicePollingJob?.cancel()
        pendingDevice = null
        deviceExpiresAt = null
        deviceSession = null
        hasLoaded = false
        profileGeneration += 1L
        storedState = SimklStoredAuthState()
        accessToken = null
        publish(isLoading = false, error = null)
    }

    override fun removeStoredProfile(profileId: Int): Unit = synchronized(stateLock) {
        SimklAuthStorage.removeProfile(profileId)
    }

    fun snapshot(): SimklAuthUiState {
        ensureLoaded()
        return uiState.value
    }

    fun hasRequiredCredentials(): Boolean = SimklConfig.CLIENT_ID.isNotBlank()

    suspend fun onConnectRequested(): String? {
        ensureLoaded()
        if (!hasRequiredCredentials()) {
            publish(error = SimklAuthError.MISSING_CLIENT_ID)
            return null
        }

        if (isDesktop) {
            return startDeviceAuthorization()
        }

        val material = generateSimklPkceMaterial()
        SimklAuthStorage.saveCodeVerifier(material.verifier)
        storedState = storedState.copy(
            pendingAuthorizationState = material.state,
            pendingAuthorizationStartedAtEpochMs = SimklPlatformClock.nowEpochMs(),
        )
        persistMetadata()
        publish(error = null)
        return authorizationUrl(material)
    }

    fun pendingAuthorizationUrl(): String? = synchronized(stateLock) {
        ensureLoaded()
        if (isDesktop) {
            if (deviceExpiresAt?.let { SimklPlatformClock.nowEpochMs() >= it } == true) {
                devicePollingJob?.cancel()
                profileGeneration += 1L
                finishDeviceAuthorization(SimklAuthError.AUTHORIZATION_EXPIRED)
            }
            return pendingDevice?.browserUrl()
        }
        val state = storedState.pendingAuthorizationState?.takeIf(String::isNotBlank) ?: return null
        val verifier = SimklAuthStorage.loadCodeVerifier()?.takeIf(String::isNotBlank) ?: run {
            clearPendingAuthorization()
            persistMetadata()
            publish(error = SimklAuthError.AUTHORIZATION_EXPIRED)
            return null
        }
        if (isSimklAuthorizationExpired(
                startedAtEpochMs = storedState.pendingAuthorizationStartedAtEpochMs,
                nowEpochMs = SimklPlatformClock.nowEpochMs(),
            )
        ) {
            clearPendingAuthorization()
            persistMetadata()
            publish(error = SimklAuthError.AUTHORIZATION_EXPIRED)
            return null
        }
        return authorizationUrl(
            SimklPkceMaterial(
                verifier = verifier,
                challenge = SimklPkceCrypto.sha256(verifier.encodeToByteArray()).base64UrlWithoutPadding(),
                state = state,
            ),
        )
    }

    fun onCancelAuthorization(): Unit = synchronized(stateLock) {
        ensureLoaded()
        devicePollingJob?.cancel()
        profileGeneration += 1L
        if (isDesktop) {
            finishDeviceAuthorization(null)
        } else {
            clearPendingAuthorization()
            persistMetadata()
            publish(error = null)
        }
    }

    override fun handleAuthCallback(url: String): Boolean {
        ensureLoaded()
        if (isDesktop) return false
        return when (val callback = parseSimklAuthCallback(url, SimklConfig.REDIRECT_URI)) {
            SimklAuthCallback.NotSimkl -> false
            SimklAuthCallback.Invalid -> {
                clearPendingAuthorization()
                persistMetadata()
                publish(error = SimklAuthError.INVALID_CALLBACK)
                true
            }
            is SimklAuthCallback.AuthorizationCode -> {
                scope.launch { completeAuthorization(callback) }
                true
            }
        }
    }

    fun onDisconnectRequested(): Unit = synchronized(stateLock) {
        ensureLoaded()
        val revoked = deviceSession
        val refresh = refreshing?.takeIf { it.session === revoked }
        if (refresh != null) refresh.disconnectRequested = true
        invalidateCredentials(null)
        if (revoked != null && refresh == null) revokeDeviceSession(revoked)
    }

    private fun revokeDeviceSession(session: SimklV2Session) {
        scope.launch {
            try {
                deviceAuth.revoke(session)
            } catch (_: SimklOAuthFailure) {
                log.w { "Simkl remote revocation could not be confirmed" }
            }
        }
    }

    internal fun requestGeneration(): Long = synchronized(stateLock) {
        ensureLoaded()
        profileGeneration
    }

    internal suspend fun authorizedAccessToken(): String? {
        ensureLoaded()
        if (isDesktop) return desktopAccessToken()
        return synchronized(stateLock) {
            val token = accessToken?.takeIf(String::isNotBlank) ?: return null
            val expiresAt = storedState.tokenExpiresAtEpochMs
            if (expiresAt != null && SimklPlatformClock.nowEpochMs() >= expiresAt - TOKEN_EXPIRY_SKEW_MS) {
                invalidateCredentials(SimklAuthError.AUTHORIZATION_EXPIRED)
                null
            } else token
        }
    }

    internal suspend fun recoverUnauthorizedResponse(rejected: String): String? {
        if (isDesktop) return desktopAccessToken(rejected)
        synchronized(stateLock) {
            if (accessToken == rejected) invalidateCredentials(SimklAuthError.AUTHORIZATION_REVOKED)
        }
        return null
    }

    private suspend fun desktopAccessToken(rejected: String? = null): String? {
        val generation = requestGeneration()
        return refreshMutex.withLock {
            val operation = synchronized(stateLock) {
                if (!isCurrentDeviceGeneration(generation)) return@withLock null
                val current = deviceSession ?: return@withLock null
                val now = SimklPlatformClock.nowEpochMs()
                if (current.accessToken != rejected && now < current.expiresAt - TOKEN_EXPIRY_SKEW_MS) {
                    return@withLock current.accessToken
                }
                if (now < refreshRetryAfter) return@withLock null
                DeviceRefresh(deviceProfileId, current).also { refreshing = it }
            }
            // Finish handling a rotated token even if its requesting screen was closed.
            withContext(NonCancellable) {
                val result = try {
                    Result.success(deviceAuth.refresh(operation.session))
                } catch (error: SimklOAuthFailure) {
                    Result.failure(error)
                }
                synchronized(stateLock) {
                    refreshing = null
                    val renewed = result.getOrNull()
                    if (operation.disconnectRequested) {
                        revokeDeviceSession(renewed ?: operation.session)
                        return@synchronized null
                    }
                    if (!isCurrentDeviceGeneration(generation)) {
                        if (renewed != null && operation.profileId != ProfileRepository.activeProfileId) {
                            persistRotationForInactiveProfile(operation, renewed)
                        }
                        return@synchronized null
                    }
                    if (renewed != null) {
                        return@synchronized renewed.accessToken.takeIf { storeDeviceSession(renewed) }
                    }
                    val reason = (result.exceptionOrNull() as SimklOAuthFailure).reason
                    if (reason == SimklAuthError.AUTHORIZATION_REVOKED ||
                        reason == SimklAuthError.AUTHORIZATION_EXPIRED ||
                        reason == SimklAuthError.INVALID_CLIENT_ID
                    ) {
                        invalidateCredentials(reason)
                    } else {
                        refreshRetryAfter = SimklPlatformClock.nowEpochMs() + 30_000L
                        publish(error = reason)
                    }
                    null
                }
            }
        }
    }

    private fun persistRotationForInactiveProfile(operation: DeviceRefresh, renewed: SimklV2Session) {
        // Never resurrect a removed or disconnected profile, or overwrite a newer grant.
        try {
            val previous = json.encodeToString(operation.session)
            if (SimklAuthStorage.loadDeviceSession(operation.profileId) == previous) {
                SimklAuthStorage.saveDeviceSession(operation.profileId, json.encodeToString(renewed))
            }
        } catch (_: Exception) {
            log.w { "Could not save the renewed Simkl session for an inactive profile" }
        }
    }

    suspend fun refreshUserSettings(): String? {
        authorizedAccessToken() ?: return null
        return if (fetchAndStoreUserSettings()) storedState.username else null
    }

    internal suspend fun synchronizeUserSettings(activityWatermark: String?) {
        authorizedAccessToken() ?: return
        when (simklSettingsRefreshAction(storedState, activityWatermark)) {
            SimklSettingsRefreshAction.NONE -> Unit
            SimklSettingsRefreshAction.RECORD_WATERMARK -> {
                storedState = storedState.copy(settingsActivityWatermark = activityWatermark)
                persistMetadata()
            }
            SimklSettingsRefreshAction.FETCH -> {
                fetchAndStoreUserSettings(activityWatermark)
            }
        }
    }

    private suspend fun startDeviceAuthorization(): String? {
        val generation = synchronized(stateLock) {
            ensureLoaded()
            if (deviceSession != null || _uiState.value.isLoading) return null
            pendingDevice?.browserUrl()?.let { return it }
            profileGeneration += 1
            publish(isLoading = true, error = null)
            profileGeneration
        }
        val material = generateSimklPkceMaterial()
        val startedAt = SimklPlatformClock.nowEpochMs()
        val device = try {
            deviceAuth.start(material)
        } catch (error: CancellationException) {
            synchronized(stateLock) {
                if (isCurrentDeviceGeneration(generation)) finishDeviceAuthorization(null)
            }
            throw error
        } catch (error: SimklOAuthFailure) {
            synchronized(stateLock) {
                if (isCurrentDeviceGeneration(generation)) finishDeviceAuthorization(error.reason)
            }
            return null
        }
        return synchronized(stateLock) {
            if (!isCurrentDeviceGeneration(generation)) return null
            val expiresAt = startedAt + device.expiresIn * 1_000L
            if (SimklPlatformClock.nowEpochMs() >= expiresAt) {
                finishDeviceAuthorization(SimklAuthError.AUTHORIZATION_EXPIRED)
                return null
            }
            pendingDevice = device
            deviceExpiresAt = expiresAt
            publish(isLoading = false, error = null)
            devicePollingJob = scope.launch {
                pollDeviceAuthorization(device, material.verifier, expiresAt, generation)
            }
            device.browserUrl()
        }
    }

    private suspend fun pollDeviceAuthorization(
        device: SimklDeviceCode,
        verifier: String,
        expiresAt: Long,
        generation: Long,
    ) {
        val session = try {
            deviceAuth.poll(device, verifier, expiresAt)
        } catch (error: SimklOAuthFailure) {
            synchronized(stateLock) {
                if (isCurrentDeviceGeneration(generation)) finishDeviceAuthorization(error.reason)
            }
            return
        }
        synchronized(stateLock) {
            if (!isCurrentDeviceGeneration(generation)) return
            pendingDevice = null
            deviceExpiresAt = null
            if (!storeDeviceSession(session)) return
        }
        fetchAndStoreUserSettings()
        synchronized(stateLock) {
            if (!isCurrentDeviceGeneration(generation)) return
            SimklSyncRepository.refreshAsync(
                intent = TrackingRefreshIntent.INVALIDATED,
                origin = SimklRefreshOrigin.AUTHORIZATION,
            )
        }
    }

    private fun isCurrentDeviceGeneration(generation: Long): Boolean =
        profileGeneration == generation && deviceProfileId == ProfileRepository.activeProfileId

    private fun finishDeviceAuthorization(error: SimklAuthError?) {
        pendingDevice = null
        deviceExpiresAt = null
        publish(isLoading = false, error = error)
    }

    private fun storeDeviceSession(session: SimklV2Session): Boolean {
        try {
            SimklAuthStorage.saveDeviceSession(deviceProfileId, json.encodeToString(session))
        } catch (_: Exception) {
            invalidateCredentials(SimklAuthError.TOKEN_STORAGE_FAILED)
            return false
        }
        deviceSession = session
        refreshRetryAfter = 0L
        storedState = storedState.copy(tokenExpiresAtEpochMs = session.expiresAt)
        publish(isLoading = false, error = null)
        return true
    }

    private suspend fun completeAuthorization(callback: SimklAuthCallback.AuthorizationCode) =
        authorizationMutex.withLock {
            publish(isLoading = true, error = null)
            val expectedState = storedState.pendingAuthorizationState
            val verifier = SimklAuthStorage.loadCodeVerifier()
            val isExpired = isSimklAuthorizationExpired(
                startedAtEpochMs = storedState.pendingAuthorizationStartedAtEpochMs,
                nowEpochMs = SimklPlatformClock.nowEpochMs(),
            )
            if (expectedState.isNullOrBlank() || verifier.isNullOrBlank() || isExpired) {
                clearPendingAuthorization()
                persistMetadata()
                publish(isLoading = false, error = SimklAuthError.AUTHORIZATION_EXPIRED)
                return@withLock
            }
            if (!constantTimeEquals(callback.state, expectedState)) {
                clearPendingAuthorization()
                persistMetadata()
                publish(isLoading = false, error = SimklAuthError.INVALID_CALLBACK_STATE)
                return@withLock
            }

            val request = SimklTokenRequest(
                code = callback.code,
                clientId = SimklConfig.CLIENT_ID,
                codeVerifier = verifier,
                redirectUri = SimklConfig.REDIRECT_URI,
            )
            val response = try {
                SimklApi.client.execute(
                    SimklApiRequest(
                        method = SimklHttpMethod.POST,
                        path = "/oauth/token",
                        body = json.encodeToString(request),
                        requiresAuthentication = false,
                        retryPolicy = SimklRetryPolicy.NEVER,
                    ),
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                log.w { "Simkl token exchange failed" }
                clearPendingAuthorization()
                persistMetadata()
                publish(isLoading = false, error = SimklAuthError.TOKEN_EXCHANGE_FAILED)
                return@withLock
            }
            val token = runCatching { json.decodeFromString<SimklTokenResponse>(response.body) }
                .getOrNull()
                ?.takeIf { it.accessToken.isNotBlank() }
            if (token == null) {
                clearPendingAuthorization()
                persistMetadata()
                publish(isLoading = false, error = SimklAuthError.INVALID_TOKEN_RESPONSE)
                return@withLock
            }

            accessToken = token.accessToken
            SimklAuthStorage.saveAccessToken(token.accessToken)
            clearPendingAuthorization()
            storedState = storedState.copy(
                tokenExpiresAtEpochMs = token.expiresIn
                    ?.takeIf { seconds -> seconds > 0L }
                    ?.let { seconds -> SimklPlatformClock.nowEpochMs() + seconds * 1_000L },
            )
            persistMetadata()
            publish(isLoading = false, error = null)
            fetchAndStoreUserSettings()
            SimklSyncRepository.refreshAsync(
                intent = TrackingRefreshIntent.INVALIDATED,
                origin = SimklRefreshOrigin.AUTHORIZATION,
            )
        }

    private suspend fun fetchAndStoreUserSettings(activityWatermark: String? = null): Boolean {
        val generation = requestGeneration()
        val response = try {
            SimklApi.client.execute(
                SimklApiRequest(
                    method = SimklHttpMethod.POST,
                    path = "/users/settings",
                ),
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            log.w { "Failed to fetch Simkl user settings" }
            return false
        }
        val settings = runCatching { json.decodeFromString<SimklUserSettingsResponse>(response.body) }
            .getOrNull() ?: return false
        return synchronized(stateLock) {
            if (profileGeneration != generation || (isDesktop && !isCurrentDeviceGeneration(generation))) {
                return false
            }
            storedState = storedState.copy(
                username = settings.user?.name,
                accountId = settings.account?.id,
                hasFetchedUserSettings = true,
                settingsActivityWatermark = activityWatermark ?: storedState.settingsActivityWatermark,
            )
            persistMetadata()
            publish(error = null)
            true
        }
    }

    private fun loadFromDisk() {
        devicePollingJob?.cancel()
        profileGeneration += 1L
        hasLoaded = true
        if (isDesktop) deviceProfileId = ProfileRepository.activeProfileId
        storedState = SimklAuthStorage.loadMetadataPayload(if (isDesktop) deviceProfileId else null)
            ?.trim()
            ?.takeIf(String::isNotEmpty)
            ?.let { payload ->
                runCatching { json.decodeFromString<SimklStoredAuthState>(payload) }
                    .onFailure { log.w { "Failed to parse Simkl auth metadata" } }
                    .getOrNull()
            }
            ?: SimklStoredAuthState()
        if (isDesktop) {
            pendingDevice = null
            deviceExpiresAt = null
            refreshRetryAfter = 0L
            accessToken = null
            val legacy = SimklAuthStorage.loadAccessToken() != null || storedState.hasPendingAuthorization
            var loadError: SimklAuthError? = null
            deviceSession = try {
                SimklAuthStorage.loadDeviceSession(deviceProfileId)
                    ?.let { json.decodeFromString<SimklV2Session>(it) }
                    ?.takeIf {
                        it.clientId == SimklConfig.CLIENT_ID && it.accessToken.isNotBlank() &&
                            it.refreshToken.isNotBlank() && it.expiresAt > 0 &&
                            it.scope.split(' ').containsAll(SIMKL_DEVICE_SCOPE.split(' '))
                    }
            } catch (_: Exception) {
                loadError = SimklAuthError.TOKEN_STORAGE_FAILED
                null
            }
            if (legacy) {
                SimklAuthStorage.saveAccessToken(null)
                clearPendingAuthorization()
            }
            if (deviceSession == null) storedState = SimklStoredAuthState()
            storedState = storedState.copy(tokenExpiresAtEpochMs = deviceSession?.expiresAt)
            persistMetadata()
            publish(isLoading = false, error = loadError)
            return
        }
        accessToken = SimklAuthStorage.loadAccessToken()?.takeIf(String::isNotBlank)
        if (accessToken != null && storedState.tokenExpiresAtEpochMs?.let { expiresAt ->
                SimklPlatformClock.nowEpochMs() >= expiresAt - TOKEN_EXPIRY_SKEW_MS
            } == true
        ) {
            accessToken = null
            SimklAuthStorage.saveAccessToken(null)
            storedState = SimklStoredAuthState()
            persistMetadata()
        }
        val hasWrongPlatformAuthorization = storedState.hasPendingPinAuthorization
        val hasExpiredAuthorization = when {
            storedState.hasPendingPinAuthorization -> isSimklPinAuthorizationExpired(
                expiresAtEpochMs = storedState.pendingPinExpiresAtEpochMs,
                nowEpochMs = SimklPlatformClock.nowEpochMs(),
            )
            !storedState.pendingAuthorizationState.isNullOrBlank() -> isSimklAuthorizationExpired(
                startedAtEpochMs = storedState.pendingAuthorizationStartedAtEpochMs,
                nowEpochMs = SimklPlatformClock.nowEpochMs(),
            )
            else -> false
        }
        if (hasWrongPlatformAuthorization || hasExpiredAuthorization) {
            clearPendingAuthorization()
            persistMetadata()
        }
        publish(error = null)
    }

    private fun invalidateCredentials(error: SimklAuthError?) {
        devicePollingJob?.cancel()
        profileGeneration += 1L
        accessToken = null
        deviceSession = null
        pendingDevice = null
        deviceExpiresAt = null
        refreshRetryAfter = 0L
        val storageError = if (isDesktop) {
            runCatching { SimklAuthStorage.saveDeviceSession(deviceProfileId, null) }.isFailure
        } else {
            SimklAuthStorage.saveAccessToken(null)
            false
        }
        clearPendingAuthorization()
        storedState = SimklStoredAuthState()
        persistMetadata()
        SimklSyncRepository.clearLocalState()
        publish(isLoading = false, error = if (storageError) SimklAuthError.TOKEN_STORAGE_FAILED else error)
    }

    private fun clearPendingAuthorization() {
        SimklAuthStorage.saveCodeVerifier(null)
        storedState = storedState.copy(
            pendingAuthorizationState = null,
            pendingAuthorizationStartedAtEpochMs = null,
            pendingPinUserCode = null,
            pendingPinVerificationUrl = null,
            pendingPinIntervalSeconds = null,
            pendingPinExpiresAtEpochMs = null,
        )
    }

    private fun persistMetadata() {
        SimklAuthStorage.saveMetadataPayload(
            json.encodeToString(storedState), if (isDesktop) deviceProfileId else null,
        )
    }

    private fun publish(
        isLoading: Boolean = _uiState.value.isLoading,
        error: SimklAuthError? = _uiState.value.error,
    ) {
        val authenticated = if (isDesktop) deviceSession != null else !accessToken.isNullOrBlank()
        _isAuthenticated.value = authenticated
        _uiState.value = SimklAuthUiState(
            mode = when {
                authenticated -> SimklConnectionMode.CONNECTED
                (pendingDevice != null || storedState.hasPendingAuthorization) -> SimklConnectionMode.AWAITING_APPROVAL
                else -> SimklConnectionMode.DISCONNECTED
            },
            credentialsConfigured = hasRequiredCredentials(),
            isLoading = isLoading,
            username = storedState.username,
            accountId = storedState.accountId,
            tokenExpiresAtEpochMs = storedState.tokenExpiresAtEpochMs,
            pendingAuthorizationStartedAtEpochMs = storedState.pendingAuthorizationStartedAtEpochMs,
            usesPinFlow = isDesktop,
            pendingPinUserCode = pendingDevice?.userCode,
            pendingPinVerificationUrl = pendingDevice?.browserUrl(),
            pendingPinExpiresAtEpochMs = deviceExpiresAt,
            error = error,
        )
    }

    private fun authorizationUrl(material: SimklPkceMaterial): String =
        buildSimklAuthorizationUrl(
            clientId = SimklConfig.CLIENT_ID,
            redirectUri = SimklConfig.REDIRECT_URI,
            appName = SimklConfig.APP_NAME,
            appVersion = simklAppVersion,
            material = material,
        )

    private const val TOKEN_EXPIRY_SKEW_MS = 60_000L
}

@Serializable
private data class SimklTokenRequest(
    val code: String,
    @SerialName("client_id") val clientId: String,
    @SerialName("code_verifier") val codeVerifier: String,
    @SerialName("redirect_uri") val redirectUri: String,
    @SerialName("grant_type") val grantType: String = "authorization_code",
)

@Serializable
private data class SimklTokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String? = null,
    val scope: String? = null,
    @SerialName("expires_in") val expiresIn: Long? = null,
)

@Serializable
private data class SimklUserSettingsResponse(
    val user: SimklUser? = null,
    val account: SimklAccount? = null,
)

@Serializable
private data class SimklUser(
    val name: String? = null,
)

@Serializable
private data class SimklAccount(
    val id: Long? = null,
)
