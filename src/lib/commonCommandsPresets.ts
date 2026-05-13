export type CommandCategory =
  | "nav"
  | "git"
  | "network"
  | "process"
  | "system"
  | "files"
  | "env";

export interface PresetCommand {
  command: string;
  description?: string;
  category?: CommandCategory;
}

export const WINDOWS_PRESET_COMMANDS: PresetCommand[] = [
  { command: "cd ", description: "Change directory", category: "nav" },
  { command: "cd ..", description: "Go up one directory", category: "nav" },
  { command: "dir", description: "List directory (cmd / PS alias)", category: "nav" },
  { command: "ls", description: "List directory (PS alias)", category: "nav" },
  { command: "pwd", description: "Print working directory", category: "nav" },
  { command: "cls", description: "Clear screen", category: "nav" },

  { command: "git status", description: "Show working tree status", category: "git" },
  { command: "git log --oneline -20", description: "Recent commits, one line each", category: "git" },
  { command: "git pull", description: "Fetch and merge from upstream", category: "git" },
  { command: "git push", description: "Push current branch", category: "git" },
  { command: "git commit -am ", description: "Commit all tracked changes", category: "git" },
  { command: "git diff", description: "Unstaged changes", category: "git" },
  { command: "git checkout ", description: "Switch branch / restore file", category: "git" },
  { command: "git branch", description: "List branches", category: "git" },

  { command: "ipconfig /all", description: "Show all network adapter info", category: "network" },
  { command: "ping ", description: "Ping a host", category: "network" },
  { command: "tracert ", description: "Trace route to a host", category: "network" },
  { command: "Test-NetConnection ", description: "Probe TCP port reachability", category: "network" },
  { command: "netstat -ano", description: "List sockets with PIDs", category: "network" },

  { command: "Get-Process", description: "List processes", category: "process" },
  { command: "Stop-Process -Id ", description: "Kill a process by PID", category: "process" },
  { command: "Get-Service", description: "List services", category: "process" },
  { command: "tasklist", description: "List processes (cmd)", category: "process" },
  { command: "taskkill /pid ", description: "Kill a process by PID (cmd)", category: "process" },

  { command: "systeminfo", description: "OS / hardware summary", category: "system" },
  { command: "hostname", description: "Print machine hostname", category: "system" },
  { command: "whoami", description: "Print current user", category: "system" },
  { command: "Get-Date", description: "Current date & time", category: "system" },
  { command: "$PSVersionTable", description: "Show PowerShell version table", category: "system" },

  { command: "Get-Content ", description: "Print file contents", category: "files" },
  { command: "New-Item -ItemType Directory -Path ", description: "Create directory", category: "files" },
  { command: "Copy-Item ", description: "Copy file or directory", category: "files" },
  { command: "Remove-Item -Recurse -Force ", description: "Delete recursively (review path before running)", category: "files" },

  { command: "Get-ChildItem env:", description: "List environment variables", category: "env" },
  { command: "$env:PATH", description: "Print PATH", category: "env" },
];
