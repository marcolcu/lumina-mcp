import { useState } from "react"
import { 
  Copy, 
  Check, 
  Sparkles, 
  Command, 
  Cpu, 
  Laptop,
  Terminal,
  Info
} from "lucide-react"
import { useTranslation } from "react-i18next"

interface ClientConfig {
  id: string
  name: string
  icon: any
  fileLabel: string
  format?: 'json' | 'toml'
  paths: {
    mac: string
    windows: string
    linux: string
  }
  description: string
  instructions: string[]
}

const CLIENTS: ClientConfig[] = [
  {
    id: "antigravity",
    name: "Antigravity",
    icon: Sparkles,
    fileLabel: "Antigravity Config File",
    format: "json",
    paths: {
      mac: "~/.gemini/config/mcp_config.json",
      windows: "%USERPROFILE%\\.gemini\\config\\mcp_config.json",
      linux: "~/.gemini/config/mcp_config.json"
    },
    description: "Antigravity is Gemini's agentic AI coding environment. To add Lumina MCP, register it in your mcp_config.json configuration file.",
    instructions: [
      "Open or create the config file at your OS-specific path",
      "Paste the JSON configuration block inside the \"mcpServers\" object",
      "Restart Antigravity to automatically load all Lumina MCP tools"
    ]
  },
  {
    id: "cursor",
    name: "Cursor",
    icon: Command,
    fileLabel: "Cursor Config File",
    format: "json",
    paths: {
      mac: "~/.cursor/mcp.json",
      windows: "%USERPROFILE%\\\\.cursor\\\\mcp.json",
      linux: "~/.cursor/mcp.json"
    },
    description: "Cursor is an AI-first code editor. You can register Lumina MCP through the settings UI or directly inside the Cursor MCP settings file.",
    instructions: [
      "Open Cursor Settings (Cmd+, or Ctrl+,), go to Features -> MCP and click '+ Add New MCP Server'",
      "Set Name to 'lumina-mcp', Type to 'command', and Command to 'npx -y lumina-mcp'",
      "Manually add the environment variables in the UI, OR edit the JSON settings file directly to paste the full block"
    ]
  },
  {
    id: "claude",
    name: "Claude Code",
    icon: Cpu,
    fileLabel: "Claude Code Config File",
    format: "json",
    paths: {
      mac: "~/.claude.json",
      windows: "%USERPROFILE%\\.claude.json",
      linux: "~/.claude.json"
    },
    description: "Claude Code is Anthropic's terminal-based coding agent. Configure Lumina MCP in your global Claude config file.",
    instructions: [
      "Open or create the .claude.json config file in your home directory",
      "Paste the JSON configuration block under the \"mcpServers\" key",
      "Run 'claude' in your terminal and it will automatically discover the database, git, and orchestration tools"
    ]
  },
  {
    id: "vscode",
    name: "VS Code (Cline/Roo)",
    icon: Laptop,
    fileLabel: "Cline MCP Settings File",
    format: "json",
    paths: {
      mac: "~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
      windows: "%APPDATA%\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json",
      linux: "~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"
    },
    description: "VS Code requires an MCP extension (like Cline or Roo Code) to act as the AI client, since native VS Code does not support MCP out of the box.",
    instructions: [
      "Install an MCP-compatible extension like Cline or Roo Code in VS Code",
      "Open the extension's settings panel and click 'Edit Settings File'",
      "Paste the JSON configuration block under the \"mcpServers\" key"
    ]
  },
  {
    id: "codex",
    name: "Codex",
    icon: Terminal,
    fileLabel: "Codex Config File",
    format: "toml",
    paths: {
      mac: "~/.codex/config.toml",
      windows: "%USERPROFILE%\\.codex\\config.toml",
      linux: "~/.codex/config.toml"
    },
    description: "Codex is an AI-powered coding assistant. It uses a TOML file for MCP configurations and manages them via its own CLI.",
    instructions: [
      "Run 'codex mcp add lumina-mcp --command npx --args -y,lumina-mcp' in your terminal",
      "Set your environment variables using 'codex mcp env lumina-mcp set <KEY>=<VALUE>'",
      "Alternatively, directly open the config.toml file and paste the TOML block below"
    ]
  }
]

const CONFIG_JSON = `{
  "mcpServers": {
    "lumina-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "lumina-mcp"
      ],
      "env": {
        "MYSQL_URL": "mysql://username:password@localhost:3306/database_name",
        "POSTGRES_URL": "postgresql://username:password@localhost:5432/database_name",
        "GITHUB_TOKEN": "ghp_YourGitHubPersonalAccessToken",
        "GITEA_TOKEN": "YourGiteaPersonalAccessToken",
        "GITEA_URL": "https://gitea.example.com",
        "TRELLO_API_KEY": "YourTrelloApiKey",
        "TRELLO_API_TOKEN": "YourTrelloApiToken",
        "OPENPROJECT_DOMAIN": "https://your-domain.openproject.com",
        "OPENPROJECT_API_KEY": "YourOpenProjectApiKey",
        "JIRA_EMAIL": "your-jira-email@example.com",
        "JIRA_API_TOKEN": "YourJiraApiToken",
        "JIRA_DOMAIN": "your-domain.atlassian.net"
      }
    }
  }
}`

const CONFIG_TOML = `[mcpServers.lumina-mcp]
command = "npx"
args = ["-y", "lumina-mcp"]

[mcpServers.lumina-mcp.env]
MYSQL_URL = "mysql://username:password@localhost:3306/database_name"
POSTGRES_URL = "postgresql://username:password@localhost:5432/database_name"
GITHUB_TOKEN = "ghp_YourGitHubPersonalAccessToken"
GITEA_TOKEN = "YourGiteaPersonalAccessToken"
GITEA_URL = "https://gitea.example.com"
TRELLO_API_KEY = "YourTrelloApiKey"
TRELLO_API_TOKEN = "YourTrelloApiToken"
OPENPROJECT_DOMAIN = "https://your-domain.openproject.com"
OPENPROJECT_API_KEY = "YourOpenProjectApiKey"
JIRA_EMAIL = "your-jira-email@example.com"
JIRA_API_TOKEN = "YourJiraApiToken"
JIRA_DOMAIN = "your-domain.atlassian.net"`

function SyntaxHighlightedJSON({ code }: { code: string }) {
  const lines = code.split("\n")
  return (
    <pre className="text-xs md:text-sm font-mono overflow-x-auto leading-relaxed text-foreground select-all max-h-[350px] overflow-y-auto pr-2 custom-scrollbar">
      <code>
        {lines.map((line, idx) => {
          let renderedLine = []
          
          const keyMatch = line.match(/^(\s*)"([^"]+)":/)
          if (keyMatch) {
            const indent = keyMatch[1]
            const key = keyMatch[2]
            const rest = line.substring(keyMatch[0].length)
            
            renderedLine.push(<span key="indent">{indent}</span>)
            renderedLine.push(<span key="key" className="text-sky-500 font-semibold">"{key}"</span>)
            renderedLine.push(<span key="colon" className="text-foreground/70">:</span>)
            
            const valMatch = rest.match(/\s*"([^"]+)"(,)?/)
            const arrayMatch = rest.match(/\s*\[/)
            const braceMatch = rest.match(/\s*\{/)
            
            if (valMatch) {
              const val = valMatch[1]
              const comma = valMatch[2] || ""
              
              const isEnvValue = ["MYSQL_URL", "POSTGRES_URL", "GITHUB_TOKEN", "GITEA_TOKEN", "GITEA_URL", "TRELLO_API_KEY", "TRELLO_API_TOKEN", "OPENPROJECT_DOMAIN", "OPENPROJECT_API_KEY", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_DOMAIN"].includes(key)
              const valueColor = isEnvValue ? "text-amber-500 dark:text-amber-400 font-medium" : "text-emerald-500 dark:text-emerald-400"
              
              renderedLine.push(<span key="val" className={valueColor}> "{val}"</span>)
              if (comma) renderedLine.push(<span key="comma" className="text-muted-foreground">{comma}</span>)
            } else if (arrayMatch) {
              renderedLine.push(<span key="array" className="text-yellow-500 font-bold"> [</span>)
            } else if (braceMatch) {
              renderedLine.push(<span key="brace" className="text-yellow-500 font-bold"> {"{"}</span>)
            } else {
              renderedLine.push(<span key="rest">{rest}</span>)
            }
          } else {
            const arrValMatch = line.match(/^(\s*)"([^"]+)"(,)?/)
            if (arrValMatch) {
              const indent = arrValMatch[1]
              const val = arrValMatch[2]
              const comma = arrValMatch[3] || ""
              renderedLine.push(<span key="indent">{indent}</span>)
              renderedLine.push(<span key="val" className="text-emerald-500 dark:text-emerald-400">"{val}"</span>)
              if (comma) renderedLine.push(<span key="comma" className="text-muted-foreground">{comma}</span>)
            } else {
              let chars = []
              for (let i = 0; i < line.length; i++) {
                const char = line[i]
                if (char === '{' || char === '}' || char === '[' || char === ']') {
                  chars.push(<span key={i} className="text-yellow-500/80 font-bold">{char}</span>)
                } else {
                  chars.push(char)
                }
              }
              renderedLine.push(<span key="chars">{chars}</span>)
            }
          }
          
          return (
            <div key={idx} className="hover:bg-muted/30 px-1 rounded transition-colors">
              {renderedLine}
            </div>
          )
        })}
      </code>
    </pre>
  )
}

function SyntaxHighlightedTOML({ code }: { code: string }) {
  const lines = code.split("\n")
  return (
    <pre className="text-xs md:text-sm font-mono overflow-x-auto leading-relaxed text-foreground select-all max-h-[350px] overflow-y-auto pr-2 custom-scrollbar">
      <code>
        {lines.map((line, idx) => {
          let renderedLine = []
          
          if (line.trim().startsWith("[")) {
            renderedLine.push(<span key="header" className="text-yellow-500 font-bold">{line}</span>)
          } else if (line.includes("=")) {
            const [keyPart, ...valParts] = line.split("=")
            const key = keyPart.trim()
            const val = valParts.join("=").trim()
            
            renderedLine.push(<span key="key" className="text-sky-500 font-semibold">{key}</span>)
            renderedLine.push(<span key="eq" className="text-foreground/70"> = </span>)
            
            if (val.startsWith("[")) { 
               renderedLine.push(<span key="val" className="text-emerald-500 dark:text-emerald-400">{val}</span>)
            } else { 
              const isEnvValue = ["MYSQL_URL", "POSTGRES_URL", "GITHUB_TOKEN", "TRELLO_API_KEY", "TRELLO_API_TOKEN", "OPENPROJECT_DOMAIN", "OPENPROJECT_API_KEY", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_DOMAIN"].includes(key)
              const valueColor = isEnvValue ? "text-amber-500 dark:text-amber-400 font-medium" : "text-emerald-500 dark:text-emerald-400"
              renderedLine.push(<span key="val" className={valueColor}>{val}</span>)
            }
          } else {
             renderedLine.push(<span key="rest">{line}</span>)
          }
          
          return (
            <div key={idx} className="hover:bg-muted/30 px-1 rounded transition-colors min-h-[1.5em]">
              {renderedLine.length > 0 ? renderedLine : " "}
            </div>
          )
        })}
      </code>
    </pre>
  )
}

export function CTA() {
  const { t } = useTranslation();
  const [activeClient, setActiveClient] = useState<string>("antigravity")
  const [activeOS, setActiveOS] = useState<"mac" | "windows" | "linux">("mac")
  const [copiedPath, setCopiedPath] = useState(false)
  const [copiedConfig, setCopiedConfig] = useState(false)

  const selectedClient = CLIENTS.find(c => c.id === activeClient) || CLIENTS[0]
  const currentPath = selectedClient.paths[activeOS]
  
  const isToml = selectedClient.format === 'toml'
  const currentConfig = isToml ? CONFIG_TOML : CONFIG_JSON
  const ConfigRenderer = isToml ? SyntaxHighlightedTOML : SyntaxHighlightedJSON

  const handleCopyPath = () => {
    navigator.clipboard.writeText(currentPath)
    setCopiedPath(true)
    setTimeout(() => setCopiedPath(false), 2000)
  }

  const handleCopyConfig = () => {
    navigator.clipboard.writeText(currentConfig)
    setCopiedConfig(true)
    setTimeout(() => setCopiedConfig(false), 2000)
  }

  return (
    <section className="py-24 bg-background transition-colors w-full relative overflow-hidden flex flex-col items-center">
      
      {/* Background decoration */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent to-accent/5 -z-10" />
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-accent/5 blur-[120px] rounded-full pointer-events-none -z-10" />

      <div className="max-w-4xl mx-auto px-6 text-center space-y-8 relative z-10 w-full">
        
        <h2 className="text-3xl md:text-5xl font-black tracking-tight text-foreground">
          {t('cta.title')}
        </h2>
        
        <p className="text-muted-foreground text-base md:text-lg max-w-2xl mx-auto leading-relaxed">
          {t('cta.subtitle')}
        </p>

        {/* Client Selection Chips */}
        <div className="flex flex-wrap justify-center gap-3 pt-4">
          {CLIENTS.map((client) => {
            const Icon = client.icon
            const isActive = client.id === activeClient
            return (
              <button
                key={client.id}
                onClick={() => {
                  setActiveClient(client.id)
                  setCopiedPath(false)
                  setCopiedConfig(false)
                }}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold border transition-all duration-200 active:scale-95 shadow-sm ${
                  isActive
                    ? "bg-accent/10 border-accent/80 text-foreground ring-1 ring-accent/30"
                    : "bg-card/40 border-border/80 text-muted-foreground hover:text-foreground hover:bg-card/85"
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? "text-accent" : "text-muted-foreground"}`} />
                {client.name}
              </button>
            )
          })}
        </div>

        {/* Setup Card */}
        <div className="relative group max-w-3xl mx-auto text-left mt-8">
          {/* Card Border Glow */}
          <div className="absolute -inset-1 bg-gradient-to-r from-blue-500/20 to-indigo-500/20 rounded-3xl blur-lg opacity-25 group-hover:opacity-40 transition duration-500 pointer-events-none" />
          
          <div className="relative bg-card/60 backdrop-blur-md border border-border/80 p-6 md:p-8 rounded-2xl shadow-xl space-y-6">
            
            {/* Header info */}
            <div>
              <div className="flex items-center gap-3 mb-3">
                <div className="h-8 w-8 rounded-lg bg-accent/15 text-accent flex items-center justify-center">
                  <selectedClient.icon className="h-4.5 w-4.5" />
                </div>
                <h3 className="text-lg font-bold text-foreground">
                  {t('cta.configureIn')} {selectedClient.name}
                </h3>
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {selectedClient.description}
              </p>
            </div>

            {/* Step list */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                {t('cta.installationSteps')}
              </h4>
              <ol className="space-y-2.5">
                {selectedClient.instructions.map((step, index) => (
                  <li key={index} className="flex gap-3 text-sm text-foreground/90 leading-relaxed">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Path block */}
            <div className="space-y-2">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {selectedClient.fileLabel} {t('cta.pathLabel')}
                </h4>
                
                {/* OS Toggle */}
                <div className="flex bg-background/50 border border-border/60 rounded-lg p-0.5 self-start md:self-auto">
                  {(["mac", "windows", "linux"] as const).map(os => (
                    <button
                      key={os}
                      onClick={() => setActiveOS(os)}
                      className={`text-[10px] md:text-xs px-2.5 py-1 rounded-md font-bold capitalize transition-colors ${
                        activeOS === os 
                          ? "bg-muted text-foreground shadow-sm" 
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {os}
                    </button>
                  ))}
                </div>
              </div>
              
              <div className="bg-background/80 border border-border/50 rounded-xl p-3 flex items-center justify-between gap-4 font-mono text-xs text-foreground/90">
                <span className="truncate select-all overflow-hidden whitespace-nowrap" title={currentPath}>
                  {currentPath}
                </span>
                <button
                  onClick={handleCopyPath}
                  className="p-1.5 rounded-lg border border-border/60 hover:bg-muted/80 transition-colors text-muted-foreground hover:text-foreground shrink-0 shadow-sm"
                  title="Copy path"
                >
                  {copiedPath ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            {/* Config Block */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {isToml ? "TOML Configuration" : "JSON Configuration"}
                </h4>
                <button
                  onClick={handleCopyConfig}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/60 bg-background/50 hover:bg-muted/80 hover:text-foreground transition-colors text-xs text-muted-foreground font-bold shadow-sm"
                >
                  {copiedConfig ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                      <span>{t('cta.copied')}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>{t('cta.copyConfig')}</span>
                    </>
                  )}
                </button>
              </div>
              
              <div className="relative bg-background/90 border border-border/50 p-4 rounded-xl shadow-inner">
                <ConfigRenderer code={currentConfig} />
              </div>
            </div>

            {/* Info Note */}
            <div className="flex gap-3 items-start p-4 rounded-xl bg-sky-500/10 border border-sky-500/20 mt-6">
              <Info className="h-5 w-5 text-sky-500 shrink-0 mt-0.5" />
              <div className="text-sm text-sky-600 dark:text-sky-400/90 leading-relaxed">
                <strong>{t('cta.proTip')}</strong> {t('cta.proTipDesc')}
              </div>
            </div>

          </div>
        </div>

      </div>
    </section>
  )
}
