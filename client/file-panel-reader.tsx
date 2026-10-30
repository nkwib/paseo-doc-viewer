import { type PluginFilePanelProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { docLocateRpc } from "../shared/rpc";
import { DocumentScreen } from "./document-screen";
import { readerLayout } from "./panel-layout";
import { ErrorState, LoadingState, makeStyles } from "./ui";

// The reader in Paseo's file tab, which already names the file, so it adds no header. The daemon finds
// the workspace path the reader reads by.
export function FilePanelReader({ file, workspaceId, host, theme, layout }: PluginFilePanelProps) {
  const [width, setWidth] = useState(0);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const locate = useRpc(docLocateRpc);
  const queryClient = useQueryClient();
  const located = useQuery({
    queryKey: ["doc.locate", workspaceId, file.path],
    queryFn: () => locate({ workspaceId, absolutePath: file.path }),
    retry: false,
    staleTime: Infinity,
  });
  const path = located.data?.path;
  // The daemon renders bounded pages and rows, so watching must not read the whole file through
  // the host handle. Polling in DocumentScreen remains a fallback for missed filesystem events.
  useEffect(() => file.watch((event) => {
    if (event.type !== "changed" && event.type !== "deleted") return;
    void queryClient.invalidateQueries({ queryKey: ["doc.locate", workspaceId, file.path] });
    if (path !== undefined) void queryClient.invalidateQueries({ queryKey: ["doc.open", workspaceId, path] });
  }), [file, workspaceId, path, queryClient]);
  return (
    <View style={styles.screen} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {located.error ? (
        <ErrorState theme={theme} styles={styles} error={located.error} onRetry={() => void located.refetch()} />
      ) : located.data ? (
        <DocumentScreen key={`${workspaceId}\0${located.data.path}`} host={host} theme={theme} layout={readerLayout(layout, width)} phone={layout.compact} chooser={false}
          params={{ workspaceId, path: located.data.path }} />
      ) : (
        <LoadingState theme={theme} styles={styles} />
      )}
    </View>
  );
}
