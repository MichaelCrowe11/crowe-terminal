// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package croweauth

import "golang.org/x/sys/windows"

func replaceMarker(source, target string) error {
	sourcePtr, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	targetPtr, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(sourcePtr, targetPtr, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}

func syncDirectory(string) error {
	// MoveFileEx uses WRITE_THROUGH; Windows does not support POSIX directory fsync.
	return nil
}
