import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Crosshair } from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import {
  breakpointModesFor,
  parseBreakpointModes,
  resolveBreakpointMode,
} from "../../dapDebugModel";
import { useContextMenu, type MenuItem } from "../../../../ContextMenu";
import {
  parseVariables,
  updateNode,
  variableDataBreakpointTargetKey,
  type VarEditState,
  type VarNode,
} from "./debugPanelShared";

export function useDebugVariables(
  debug: CodeDebugSession,
  selectedFrameId: number | null,
  stopped: boolean,
) {
  const [variables, setVariables] = useState<VarNode[]>([]);
  const [watchNodes, setWatchNodes] = useState<VarNode[]>([]);
  const [watchTick, setWatchTick] = useState(0);
  const [watchInput, setWatchInput] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  const [sortMode, setSortMode] = useState<"natural" | "alphabetical">("natural");
  const previousValuesRef = useRef<Map<string, string>>(new Map());
  const [edit, setEdit] = useState<VarEditState>({ node: null, value: "" });
  const [addingDataBreakpointKey, setAddingDataBreakpointKey] = useState<string | null>(null);
  const [preferredDataBreakpointMode, setPreferredDataBreakpointMode] = useState("");
  const [dataBreakpointNotice, setDataBreakpointNotice] = useState<{
    added: boolean;
    message: string;
  } | null>(null);

  const canSetVariable = debug.capabilities.supportsSetVariable === true;
  const canAddDataBreakpoint = stopped && debug.capabilities.supportsDataBreakpoints === true;
  const dataBreakpointModes = breakpointModesFor(parseBreakpointModes(debug.capabilities), "data");
  const dataBreakpointMode = resolveBreakpointMode(
    preferredDataBreakpointMode || undefined,
    dataBreakpointModes,
    "data",
  );

  const {
    addDataBreakpoint: sessionAddDataBreakpoint,
    fetchScopes,
    fetchVariables,
    evaluate,
    setVariable: sessionSetVariable,
  } = debug;

  const addDataBreakpointForNode = useCallback(async (node: VarNode) => {
    const targetKey = variableDataBreakpointTargetKey(node);
    setAddingDataBreakpointKey(targetKey);
    setDataBreakpointNotice(null);
    const result = await sessionAddDataBreakpoint({
      name: node.name,
      variablesReference: node.parentRef > 0 ? node.parentRef : undefined,
      frameId: node.parentRef > 0 ? undefined : selectedFrameId ?? undefined,
      mode: dataBreakpointMode,
    });
    setDataBreakpointNotice(result);
    setAddingDataBreakpointKey((current) => current === targetKey ? null : current);
  }, [dataBreakpointMode, selectedFrameId, sessionAddDataBreakpoint]);

  // On each stop, load the selected frame's scopes -> variables (D4).
  useEffect(() => {
    setEdit({ node: null, value: "" });
    if (selectedFrameId == null) {
      setVariables([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const scopesBody = await fetchScopes(selectedFrameId);
      const scopes = (scopesBody && typeof scopesBody === "object"
        ? (scopesBody as { scopes?: unknown }).scopes
        : null);
      const refs = Array.isArray(scopes)
        ? scopes.flatMap((s) => {
            const rec = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
            return typeof rec.variablesReference === "number" && rec.variablesReference > 0
              ? [{ name: String(rec.name ?? "scope"), ref: rec.variablesReference }]
              : [];
          })
        : [];
      const roots: VarNode[] = [];
      const currentValues = new Map<string, string>();
      for (const scope of refs) {
        const rawVars = parseVariables(await fetchVariables(scope.ref), scope.ref);
        const vars = rawVars.map((v) => {
          const key = `${scope.ref}:${v.name}`;
          currentValues.set(key, v.value);
          const prev = previousValuesRef.current.get(key);
          const hasChanged = prev !== undefined && prev !== v.value;
          return { ...v, hasChanged };
        });
        roots.push({
          name: scope.name,
          value: "",
          type: null,
          variablesReference: scope.ref,
          parentRef: 0,
          dataBreakpointExpression: false,
          children: vars,
          expanded: true,
        });
      }
      previousValuesRef.current = currentValues;
      if (!cancelled) setVariables(roots);
    })();
    return () => { cancelled = true; };
  }, [fetchScopes, fetchVariables, selectedFrameId]);

  // Re-evaluate watch expressions on each stop / frame change / edit.
  const watchItems = debug.watchItems ?? debug.watchExpressions.map((e, i) => ({ id: `watch-${i}`, expression: e }));
  useEffect(() => {
    let cancelled = false;
    if (!stopped || selectedFrameId == null) {
      setWatchNodes(watchItems.map((item) => ({
        name: item.expression,
        watchId: item.id,
        value: "",
        type: null,
        variablesReference: 0,
        parentRef: 0,
        children: null,
        expanded: false,
        dataBreakpointExpression: true,
      })));
      return;
    }
    void (async () => {
      const next = await Promise.all(watchItems.map(async (item) => {
        const result = await evaluate(item.expression, "watch");
        const key = `watch:${item.id}`;
        const prev = previousValuesRef.current.get(key);
        previousValuesRef.current.set(key, result.value);
        const hasChanged = prev !== undefined && prev !== result.value;
        return {
          name: item.expression,
          watchId: item.id,
          value: result.value,
          type: result.type,
          variablesReference: result.variablesReference,
          parentRef: 0,
          dataBreakpointExpression: true,
          children: null,
          expanded: false,
          hasChanged,
        };
      }));
      if (!cancelled) setWatchNodes(next);
    })();
    return () => { cancelled = true; };
  }, [evaluate, stopped, selectedFrameId, watchItems, watchTick]);

  const filterAndSort = useCallback((nodes: VarNode[]): VarNode[] => {
    let result = nodes;
    if (filterQuery.trim()) {
      const q = filterQuery.trim().toLowerCase();
      const filterRecursive = (list: VarNode[]): VarNode[] => {
        return list.flatMap((n) => {
          const matches = n.name.toLowerCase().includes(q) || n.value.toLowerCase().includes(q);
          const filteredChildren = n.children ? filterRecursive(n.children) : null;
          if (matches || (filteredChildren && filteredChildren.length > 0)) {
            return [{
              ...n,
              expanded: true,
              children: filteredChildren ?? n.children,
            }];
          }
          return [];
        });
      };
      result = filterRecursive(result);
    }
    if (sortMode === "alphabetical") {
      const sortRecursive = (list: VarNode[]): VarNode[] => {
        return [...list].sort((a, b) => a.name.localeCompare(b.name)).map((n) => ({
          ...n,
          children: n.children ? sortRecursive(n.children) : null,
        }));
      };
      result = sortRecursive(result);
    }
    return result;
  }, [filterQuery, sortMode]);

  const displayedVariables = useMemo(() => filterAndSort(variables), [filterAndSort, variables]);
  const displayedWatchNodes = useMemo(() => filterAndSort(watchNodes), [filterAndSort, watchNodes]);

  const makeExpandHandler = useCallback((
    setNodes: React.Dispatch<React.SetStateAction<VarNode[]>>,
  ) => (node: VarNode) => {
    setNodes((current) => updateNode(current, node, (n) => ({ ...n, expanded: !n.expanded })));
    if (!node.expanded && node.children === null && node.variablesReference > 0) {
      void fetchVariables(node.variablesReference).then((body) => {
        const children = parseVariables(body, node.variablesReference);
        setNodes((current) => updateNode(current, node, (n) => ({ ...n, children, expanded: true })));
      });
    }
  }, [fetchVariables]);

  const expandVariable = makeExpandHandler(setVariables);
  const expandWatch = makeExpandHandler(setWatchNodes);

  const startEdit = useCallback((node: VarNode) => {
    setEdit({ node, value: node.value });
  }, []);

  const submitEdit = useCallback(() => {
    const node = edit.node;
    const value = edit.value;
    setEdit({ node: null, value: "" });
    if (!node) return;
    void sessionSetVariable(node.parentRef, node.name, value).then((result) => {
      if (!result) return;
      setVariables((current) => updateNode(current, node, (n) => ({
        ...n,
        value: result.value,
        type: result.type ?? n.type,
        variablesReference: result.variablesReference,
        children: null,
        expanded: false,
      })));
      // Watch values may depend on the changed variable.
      setWatchTick((tick) => tick + 1);
    });
  }, [sessionSetVariable, edit]);

  const cancelEdit = useCallback(() => setEdit({ node: null, value: "" }), []);

  const addWatch = useCallback(() => {
    const expr = watchInput.trim();
    if (!expr) return;
    setWatchInput("");
    debug.addWatchExpression(expr);
  }, [debug, watchInput]);

  const removeWatch = useCallback((target: number | string) => {
    debug.removeWatchExpression(target);
  }, [debug]);

  const variableMenu = useContextMenu();

  const handleVariableContextMenu = useCallback((e: MouseEvent, node: VarNode, onRemove?: () => void) => {
    e.preventDefault();
    const items: MenuItem[] = [];
    const dataBreakpointEligible = node.parentRef > 0 || !!node.dataBreakpointExpression;
    if (dataBreakpointEligible && canAddDataBreakpoint) {
      items.push({
        label: `Add Data Breakpoint for "${node.name}"`,
        testId: "debug-variable-menu-data-breakpoint",
        icon: <Crosshair className="w-3.5 h-3.5" />,
        onClick: () => { void addDataBreakpointForNode(node); },
      });
    }
    items.push({
      label: `Add to Watches ("${node.name}")`,
      testId: "debug-variable-menu-add-watch",
      onClick: () => debug.addWatchExpression(node.name),
    });
    items.push({
      label: "Copy Value",
      testId: "debug-variable-menu-copy-value",
      onClick: () => { void navigator.clipboard.writeText(node.value); },
    });
    items.push({
      label: "Copy Variable Name",
      testId: "debug-variable-menu-copy-name",
      onClick: () => { void navigator.clipboard.writeText(node.name); },
    });
    if (canSetVariable && stopped) {
      items.push({ separator: true, label: "" });
      items.push({
        label: "Set Value...",
        testId: "debug-variable-menu-set-value",
        onClick: () => startEdit(node),
      });
    }
    if (onRemove) {
      items.push({ separator: true, label: "" });
      items.push({
        label: "Remove Watch",
        testId: "debug-variable-menu-remove-watch",
        danger: true,
        onClick: onRemove,
      });
    }
    variableMenu.show(e, items);
  }, [canAddDataBreakpoint, canSetVariable, stopped, addDataBreakpointForNode, debug, startEdit, variableMenu]);

  return {
    variables,
    watchNodes,
    displayedVariables,
    displayedWatchNodes,
    filterQuery,
    setFilterQuery,
    sortMode,
    setSortMode,
    watchInput,
    setWatchInput,
    edit,
    setEdit,
    addingDataBreakpointKey,
    preferredDataBreakpointMode,
    setPreferredDataBreakpointMode,
    dataBreakpointNotice,
    canSetVariable,
    canAddDataBreakpoint,
    dataBreakpointModes,
    dataBreakpointMode,
    expandVariable,
    expandWatch,
    startEdit,
    submitEdit,
    cancelEdit,
    addWatch,
    removeWatch,
    addDataBreakpointForNode,
    handleVariableContextMenu,
    variableMenu,
  };
}
