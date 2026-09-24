// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import createDOMPurify from "dompurify";

// Monaco removes all hooks after each call; never share Mermaid's default instance.
export const MonacoDOMPurify = createDOMPurify(window);
