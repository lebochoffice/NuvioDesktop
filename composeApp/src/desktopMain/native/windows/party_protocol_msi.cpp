// MSI-only custom action. The standard MSI registry actions perform the writes,
// removals and rollback using rows added to this transaction.
#include <windows.h>
#include <msi.h>
#include <msiquery.h>
#include <array>
#include <string>

#ifdef _M_IX86
#pragma comment(linker, "/EXPORT:NuvioPartySchema=_NuvioPartySchema@4")
#pragma comment(linker, "/EXPORT:NuvioFamilyCheckVersion=_NuvioFamilyCheckVersion@4")
#endif

namespace {
struct Handle {
    MSIHANDLE value = 0;
    ~Handle() { if (value) MsiCloseHandle(value); }
};

constexpr wchar_t scheme[] = L"Software\\Classes\\nuvio";
constexpr wchar_t commandKey[] = L"Software\\Classes\\nuvio\\shell\\open\\command";
constexpr wchar_t ownerName[] = L"NuvioFamilyOwner";
constexpr wchar_t description[] = L"URL:Nuvio Family Party";

LONG readValue(HKEY hive, const wchar_t* key, const wchar_t* name, std::wstring& result) {
    wchar_t buffer[32768];
    DWORD bytes = sizeof(buffer);
    const LONG status = RegGetValueW(hive, key, name, RRF_RT_REG_SZ | RRF_NOEXPAND, nullptr, buffer, &bytes);
    if (status == ERROR_SUCCESS) result.assign(buffer);
    return status;
}

bool matches(HKEY hive, const wchar_t* key, const wchar_t* name, const std::wstring& expected) {
    std::wstring value;
    return readValue(hive, key, name, value) == ERROR_SUCCESS && value == expected;
}

bool missingKey(HKEY hive) {
    HKEY key = nullptr;
    const LONG status = RegOpenKeyExW(hive, scheme, 0, KEY_QUERY_VALUE, &key);
    if (key) RegCloseKey(key);
    // Access errors are treated as an existing registration.
    return status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND;
}

std::wstring recordString(MSIHANDLE record, UINT field) {
    wchar_t buffer[32768];
    DWORD length = _countof(buffer);
    if (MsiRecordGetStringW(record, field, buffer, &length) != ERROR_SUCCESS) return {};
    return {buffer, length};
}

UINT addRow(MSIHANDLE view, const wchar_t* id, const wchar_t* key, const wchar_t* name,
            const wchar_t* value, const std::wstring& component) {
    Handle row{MsiCreateRecord(6)};
    if (!row.value || MsiRecordSetStringW(row.value, 1, id) ||
        MsiRecordSetInteger(row.value, 2, 0) || MsiRecordSetStringW(row.value, 3, key) ||
        (name && MsiRecordSetStringW(row.value, 4, name)) ||
        MsiRecordSetStringW(row.value, 5, value) ||
        MsiRecordSetStringW(row.value, 6, component.c_str())) return ERROR_INSTALL_FAILURE;
    return MsiViewModify(view, MSIMODIFY_INSERT_TEMPORARY, row.value);
}

UINT configureSchema(MSIHANDLE session) {
    Handle db{MsiGetActiveDatabase(session)}, lookup, rows;
    if (!db.value || MsiDatabaseOpenViewW(db.value,
        L"SELECT `Value`, `Component_` FROM `Registry` WHERE `Registry` = 'NuvioFamilyPartyForkCommand'",
        &lookup.value) || MsiViewExecute(lookup.value, 0)) return ERROR_INSTALL_FAILURE;
    Handle command;
    if (MsiViewFetch(lookup.value, &command.value)) return ERROR_INSTALL_FAILURE;
    const std::wstring commandTemplate = recordString(command.value, 1);
    const std::wstring component = recordString(command.value, 2);
    MsiViewClose(lookup.value);

    INSTALLSTATE installed, action;
    if (component.empty() || commandTemplate.empty() ||
        MsiGetComponentStateW(session, component.c_str(), &installed, &action)) return ERROR_INSTALL_FAILURE;
    if (action != INSTALLSTATE_LOCAL && action != INSTALLSTATE_ABSENT) return ERROR_SUCCESS;

    wchar_t allUsers[8];
    DWORD length = _countof(allUsers);
    if (MsiGetPropertyW(session, L"ALLUSERS", allUsers, &length)) return ERROR_INSTALL_FAILURE;
    const HKEY hive = allUsers[0] == L'1' ? HKEY_LOCAL_MACHINE : HKEY_CURRENT_USER;

    std::wstring owner;
    const bool owned = readValue(hive, scheme, ownerName, owner) == ERROR_SUCCESS && !owner.empty();
    const bool ourCommand = owned && matches(hive, commandKey, nullptr, owner);
    if (action == INSTALLSTATE_LOCAL) {
        const bool foreignUserOverride = hive == HKEY_LOCAL_MACHINE && !missingKey(HKEY_CURRENT_USER);
        if (foreignUserOverride || (!ourCommand && (!missingKey(HKEY_LOCAL_MACHINE) ||
                                                    !missingKey(HKEY_CURRENT_USER)))) return ERROR_SUCCESS;
    } else if (!owned) {
        return ERROR_SUCCESS;
    }

    if (MsiDatabaseOpenViewW(db.value,
        L"SELECT `Registry`, `Root`, `Key`, `Name`, `Value`, `Component_` FROM `Registry`",
        &rows.value) || MsiViewExecute(rows.value, 0)) return ERROR_INSTALL_FAILURE;

    UINT status = addRow(rows.value, L"NuvioPartySchemaOwner", L"nuvio", ownerName,
                         commandTemplate.c_str(), component);
    if (status != ERROR_SUCCESS) return status;
    if (action == INSTALLSTATE_LOCAL || ourCommand) {
        if (action == INSTALLSTATE_LOCAL || matches(hive, scheme, nullptr, description)) {
            status = addRow(rows.value, L"NuvioPartySchemaName", L"nuvio", nullptr, description, component);
            if (status != ERROR_SUCCESS) return status;
        }
        if (action == INSTALLSTATE_LOCAL || matches(hive, scheme, L"URL Protocol", L"")) {
            status = addRow(rows.value, L"NuvioPartySchemaMarker", L"nuvio", L"URL Protocol",
                            L"[NUVIOPARTYPROTOCOLMARKER]", component);
            if (status != ERROR_SUCCESS) return status;
        }
        status = addRow(rows.value, L"NuvioPartySchemaCommand", L"nuvio\\shell\\open\\command", nullptr,
                        commandTemplate.c_str(), component);
    }
    MsiViewClose(rows.value);
    return status;
}
}

namespace {
using MsiVersion = std::array<unsigned, 3>;

bool parseMsiVersion(const wchar_t* text, MsiVersion& version) {
    constexpr MsiVersion limits{255, 255, 65535};
    for (size_t field = 0; field < version.size(); ++field) {
        if (field && *text++ != L'.') return false;
        if (*text < L'0' || *text > L'9') return false;
        unsigned value = 0;
        do {
            value = value * 10 + (*text++ - L'0');
            if (value > limits[field]) return false;
        } while (*text >= L'0' && *text <= L'9');
        version[field] = value;
    }
    return *text == L'\0';
}

UINT blockFamilyInstall(MSIHANDLE session, const wchar_t* message) {
    Handle record{MsiCreateRecord(0)};
    if (record.value && MsiRecordSetStringW(record.value, 0, message) == ERROR_SUCCESS) {
        MsiProcessMessage(session, INSTALLMESSAGE_ERROR, record.value);
    }
    return ERROR_INSTALL_FAILURE;
}
}

extern "C" __declspec(dllexport) UINT __stdcall NuvioFamilyCheckVersion(MSIHANDLE session) {
    constexpr wchar_t family[] = L"{DFE71C5B-C265-42CE-A025-396193575A13}";
    constexpr wchar_t failure[] = L"Could not verify installed Nuvio Family versions. Installation stopped.";
    wchar_t ownCode[39]{}, versionText[32]{};
    DWORD codeSize = _countof(ownCode), versionSize = _countof(versionText);
    MsiVersion incoming{};
    if (MsiGetPropertyW(session, L"ProductCode", ownCode, &codeSize) != ERROR_SUCCESS || codeSize != 38 ||
        MsiGetPropertyW(session, L"ProductVersion", versionText, &versionSize) != ERROR_SUCCESS ||
        !parseMsiVersion(versionText, incoming)) {
        return blockFamilyInstall(session, failure);
    }

    // Re-enumerate in the execute sequence, independently of UI properties.
    for (DWORD index = 0; ; ++index) {
        wchar_t installedCode[39]{};
        const UINT status = MsiEnumRelatedProductsW(family, 0, index, installedCode);
        if (status == ERROR_NO_MORE_ITEMS) return ERROR_SUCCESS;
        if (status != ERROR_SUCCESS) return blockFamilyInstall(session, failure);
        MsiVersion installed{};
        versionSize = _countof(versionText);
        if (MsiGetProductInfoExW(installedCode, nullptr, MSIINSTALLCONTEXT_MACHINE, L"VersionString",
                                versionText, &versionSize) != ERROR_SUCCESS ||
            !parseMsiVersion(versionText, installed)) {
            return blockFamilyInstall(session, failure);
        }
        if (CompareStringOrdinal(installedCode, -1, ownCode, -1, TRUE) == CSTR_EQUAL) {
            if (installed != incoming) return blockFamilyInstall(session, failure);
            continue; // Maintenance of the exact installed package remains supported.
        }
        if (installed >= incoming) {
            return blockFamilyInstall(session, L"An equal or newer Nuvio Family version is already installed.");
        }
    }
}

extern "C" __declspec(dllexport) UINT __stdcall NuvioPartySchema(MSIHANDLE session) {
    UINT status = ERROR_INSTALL_FAILURE;
    try { status = configureSchema(session); } catch (...) {}
    if (status != ERROR_SUCCESS) {
        Handle message{MsiCreateRecord(1)};
        if (message.value) {
            MsiRecordSetStringW(message.value, 0, L"Nuvio party URI registry action failed (Windows Installer error [1]).");
            MsiRecordSetInteger(message.value, 1, status);
            MsiProcessMessage(session, INSTALLMESSAGE_ERROR, message.value);
        }
        return ERROR_INSTALL_FAILURE;
    }
    return ERROR_SUCCESS;
}
