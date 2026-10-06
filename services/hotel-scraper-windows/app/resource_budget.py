"""Fail-safe resource headroom probe; no training processes are inspected or changed."""
import os


def available_memory_bytes():
    if os.name != "nt":
        return None
    import ctypes
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_uint32), ("load", ctypes.c_uint32),
            ("total_physical", ctypes.c_uint64), ("available_physical", ctypes.c_uint64),
            ("total_pagefile", ctypes.c_uint64), ("available_pagefile", ctypes.c_uint64),
            ("total_virtual", ctypes.c_uint64), ("available_virtual", ctypes.c_uint64),
            ("available_extended", ctypes.c_uint64)]
    try:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(MemoryStatus)]
        kernel.GlobalMemoryStatusEx.restype = ctypes.c_int
        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        if not kernel.GlobalMemoryStatusEx(ctypes.byref(status)):
            return None
        return status.available_physical
    except (OSError, SystemError):
        return None
