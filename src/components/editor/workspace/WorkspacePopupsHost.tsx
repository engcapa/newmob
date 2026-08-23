import type { LspDocumentSymbol, LspLocation } from "../../../lib/editor/lsp";
import type {
  GoToFileItem,
  GoToSymbolItem,
  GoToSymbolQueryResult,
  SearchEverywhereMode,
} from "./SearchEverywhere";
import { SearchEverywhere } from "./SearchEverywhere";
import type { ActionSnapshotItem } from "./workspaceActionHost";
import type { ActionResult } from "./workspaceActionRegistry";
import { RecentFilesPopup, type RecentFileEntry } from "./RecentFilesPopup";
import { StructurePopup } from "./StructurePopup";
import { QuickDocPopup } from "./QuickDocPopup";
import type { QuickDocContent } from "./referenceDocumentation";
import { LocationPeek, type LocationPeekState } from "./LocationPeek";
import { RecentLocationsDialog } from "./RecentLocationsDialog";
import type { NavigationHistoryFacade, NavigationLocation, WorkspaceLocationController } from "./navigationHistoryModel";
import type { WorkspaceSemanticIndexSnapshot } from "./workspaceSemanticIndex";

interface WorkspacePopupsHostProps {
  searchEverywhereOpen: boolean;
  searchEverywhereMode: SearchEverywhereMode;
  goToFileItems: GoToFileItem[];
  goToFileLoading: boolean;
  goToFileTruncated: boolean;
  actionSnapshots: ActionSnapshotItem[];
  symbolsAvailable: boolean;
  semanticIndex: WorkspaceSemanticIndexSnapshot;
  fetchWorkspaceSymbols: (query: string) => Promise<GoToSymbolQueryResult>;
  onCloseSearchEverywhere: () => void;
  onOpenFileItem: (item: GoToFileItem) => void;
  onOpenSymbol: (symbol: GoToSymbolItem, options?: { split: boolean }) => void;
  onRunCommand: (commandId: string) => void | Promise<ActionResult>;
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
  locationController?: WorkspaceLocationController;
  navigationFacade?: NavigationHistoryFacade;
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
  onOpenQuickDocSource?: (content: QuickDocContent) => void;
  quickDocCanGoBack?: boolean;
  quickDocCanGoForward?: boolean;
  onQuickDocBack?: () => void;
  onQuickDocForward?: () => void;

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
  actionSnapshots,
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
  locationController,
  navigationFacade,
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
  onOpenQuickDocSource,
  quickDocCanGoBack = false,
  quickDocCanGoForward = false,
  onQuickDocBack,
  onQuickDocForward,
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
        actionSnapshots={actionSnapshots}
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
          locationController={locationController}
        navigationFacade={navigationFacade}
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
        onOpenSource={onOpenQuickDocSource}
        canGoBack={quickDocCanGoBack}
        canGoForward={quickDocCanGoForward}
        onBack={onQuickDocBack}
        onForward={onQuickDocForward}
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
