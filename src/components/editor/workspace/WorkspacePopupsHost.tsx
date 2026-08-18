import type { LspDocumentSymbol, LspLocation } from "../../../lib/editor/lsp";
import type {
  GoToFileItem,
  GoToSymbolItem,
  GoToSymbolQueryResult,
  SearchEverywhereMode,
} from "./SearchEverywhere";
import { SearchEverywhere } from "./SearchEverywhere";
import { RecentFilesPopup, type RecentFileEntry } from "./RecentFilesPopup";
import { StructurePopup } from "./StructurePopup";
import { QuickDocPopup, type QuickDocContent } from "./QuickDocPopup";
import { LocationPeek, type LocationPeekState } from "./LocationPeek";
import { RecentLocationsDialog } from "./RecentLocationsDialog";
import type { NavigationLocation } from "./navigationHistoryModel";
import type { WorkspaceCommand } from "./workspaceCommands";
import type { WorkspaceSemanticIndexSnapshot } from "./workspaceSemanticIndex";

interface WorkspacePopupsHostProps {
  searchEverywhereOpen: boolean;
  searchEverywhereMode: SearchEverywhereMode;
  goToFileItems: GoToFileItem[];
  goToFileLoading: boolean;
  goToFileTruncated: boolean;
  searchableCommands: WorkspaceCommand[];
  symbolsAvailable: boolean;
  semanticIndex: WorkspaceSemanticIndexSnapshot;
  fetchWorkspaceSymbols: (query: string) => Promise<GoToSymbolQueryResult>;
  onCloseSearchEverywhere: () => void;
  onOpenFileItem: (item: GoToFileItem) => void;
  onOpenSymbol: (symbol: GoToSymbolItem, options?: { split: boolean }) => void;
  onRunCommand: (commandId: string) => void;
  onSearchText: (query: string) => void;

  recentFilesOpen: boolean;
  recentEntries: RecentFileEntry[];
  recentAdvanceNonce: number;
  recentChangedOnly?: boolean;
  onCloseRecent: () => void;
  onPickRecent: (entry: RecentFileEntry) => void;

  recentLocationsOpen?: boolean;
  recentLocationsChangedOnly?: boolean;
  workspaceId?: string;
  onCloseRecentLocations?: () => void;
  onPickRecentLocation?: (location: NavigationLocation) => void;

  structureOpen: boolean;
  structureFileTitle: string | null;
  structureSymbols: LspDocumentSymbol[];
  structureLoading: boolean;
  structureUnavailable: string | null;
  onCloseStructure: () => void;
  onPickStructure: (symbol: LspDocumentSymbol) => void;

  quickDocOpen: boolean;
  quickDocContent: QuickDocContent | null;
  onCloseQuickDoc: () => void;
  onPinQuickDoc: (content: QuickDocContent) => void;

  locationPeek: LocationPeekState | null;
  onCloseLocationPeek: () => void;
  onOpenLocation: (location: LspLocation) => void;
}

/** Hosts Code Workspace modal/quick-pick overlays outside the editor pane tree. */
export function WorkspacePopupsHost({
  searchEverywhereOpen,
  searchEverywhereMode,
  goToFileItems,
  goToFileLoading,
  goToFileTruncated,
  searchableCommands,
  symbolsAvailable,
  semanticIndex,
  fetchWorkspaceSymbols,
  onCloseSearchEverywhere,
  onOpenFileItem,
  onOpenSymbol,
  onRunCommand,
  onSearchText,
  recentFilesOpen,
  recentEntries,
  recentAdvanceNonce,
  recentChangedOnly = false,
  onCloseRecent,
  onPickRecent,
  recentLocationsOpen = false,
  recentLocationsChangedOnly = false,
  workspaceId,
  onCloseRecentLocations,
  onPickRecentLocation,
  structureOpen,
  structureFileTitle,
  structureSymbols,
  structureLoading,
  structureUnavailable,
  onCloseStructure,
  onPickStructure,
  quickDocOpen,
  quickDocContent,
  onCloseQuickDoc,
  onPinQuickDoc,
  locationPeek,
  onCloseLocationPeek,
  onOpenLocation,
}: WorkspacePopupsHostProps) {
  return (
    <>
      <SearchEverywhere
        open={searchEverywhereOpen}
        initialMode={searchEverywhereMode}
        items={goToFileItems}
        loading={goToFileLoading}
        truncated={goToFileTruncated}
        commands={searchableCommands}
        symbolsAvailable={symbolsAvailable}
        semanticIndex={semanticIndex}
        fetchSymbols={fetchWorkspaceSymbols}
        onClose={onCloseSearchEverywhere}
        onOpenFile={onOpenFileItem}
        onOpenSymbol={(symbol, options) => void onOpenSymbol(symbol, options)}
        onRunCommand={onRunCommand}
        onSearchText={onSearchText}
      />
      <RecentFilesPopup
        open={recentFilesOpen}
        entries={recentEntries}
        advanceNonce={recentAdvanceNonce}
        changedOnly={recentChangedOnly}
        onClose={onCloseRecent}
        onPick={onPickRecent}
      />
      {recentLocationsOpen && onCloseRecentLocations && onPickRecentLocation && (
        <RecentLocationsDialog
          open={recentLocationsOpen}
          initialChangedOnly={recentLocationsChangedOnly}
          workspaceId={workspaceId}
          onClose={onCloseRecentLocations}
          onSelectLocation={onPickRecentLocation}
        />
      )}
      <StructurePopup
        open={structureOpen}
        fileTitle={structureFileTitle}
        symbols={structureSymbols}
        loading={structureLoading}
        unavailableReason={structureUnavailable}
        onClose={onCloseStructure}
        onPick={onPickStructure}
      />
      <QuickDocPopup
        open={quickDocOpen}
        content={quickDocContent}
        onClose={onCloseQuickDoc}
        onPin={onPinQuickDoc}
      />
      <LocationPeek
        open={!!locationPeek}
        state={locationPeek}
        onClose={onCloseLocationPeek}
        onOpen={onOpenLocation}
      />
    </>
  );
}
