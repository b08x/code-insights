import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { useLlmConfig, useSaveLlmConfig } from '@/hooks/useConfig';
import { useUserProfile, normalizeGithubUsername } from '@/hooks/useUserProfile';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  User,
  Check,
  Minus,
  Cpu,
  Bot,
  Database,
  Loader2,
} from 'lucide-react';
import { LlmProviderCard } from '@/components/settings/LlmProviderCard';

export default function SettingsPage() {
  const { data: llmConfig, isLoading: configLoading } = useLlmConfig();
  const saveMutation = useSaveLlmConfig();
  const { profile, saveProfile } = useUserProfile();

  // Profile card state
  const [profileName, setProfileName] = useState(profile?.name ?? '');
  const [profileGithubUsername, setProfileGithubUsername] = useState(profile?.githubUsername ?? '');
  const [profileAvatarError, setProfileAvatarError] = useState(false);

  useEffect(() => {
    setProfileName(profile?.name ?? '');
    setProfileGithubUsername(profile?.githubUsername ?? '');
    setProfileAvatarError(false);
  }, [profile?.name, profile?.githubUsername]);

  const profileNormalizedUsername = normalizeGithubUsername(profileGithubUsername);
  const profileAvatarUrl = profileNormalizedUsername
    ? `https://github.com/${profileNormalizedUsername}.png`
    : '';

  const handleSaveProfile = async () => {
    await saveProfile(profileName, profileGithubUsername);
    toast.success('Profile saved');
  };

  const progressItems = [
    { label: 'AI Provider', done: !!llmConfig?.provider, required: true },
    { label: 'Knowledge Agent', done: !!llmConfig?.agent?.provider, required: false },
    { label: 'Embeddings', done: !!llmConfig?.embedding?.provider, required: false },
  ];
  const requiredDone = progressItems.filter((p) => p.required && p.done).length;
  const requiredTotal = progressItems.filter((p) => p.required).length;

  if (configLoading) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-muted-foreground">Configure your Code Insights dashboard</p>
        </div>
        <div className="h-32 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Configure your Code Insights dashboard</p>
      </div>

      {/* User Profile Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <User className="h-5 w-5" />
            <CardTitle className="text-base">Your Profile</CardTitle>
          </div>
          <CardDescription>
            Your name and GitHub avatar appear in the footer of downloaded share cards
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-full overflow-hidden bg-muted border border-border shrink-0 flex items-center justify-center">
              {profileAvatarUrl && !profileAvatarError ? (
                <img
                  src={profileAvatarUrl}
                  alt="GitHub avatar preview"
                  className="h-full w-full object-cover"
                  onError={() => setProfileAvatarError(true)}
                  onLoad={() => setProfileAvatarError(false)}
                />
              ) : (
                <span className="text-xl text-muted-foreground select-none">
                  {profileName.trim().charAt(0).toUpperCase() || '?'}
                </span>
              )}
            </div>
            <div className="text-sm">
              <p className="font-medium">{profileName.trim() || 'Your Name'}</p>
              {profileNormalizedUsername ? (
                <p className="text-muted-foreground text-xs">@{profileNormalizedUsername}</p>
              ) : (
                <p className="text-muted-foreground text-xs italic">Enter your GitHub username</p>
              )}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Display Name</label>
            <Input
              className="mt-1"
              placeholder="e.g. Srikanth Rao"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
            />
          </div>

          <div>
            <label className="text-sm font-medium">GitHub Username</label>
            <Input
              className="mt-1"
              placeholder="e.g. melagiri"
              value={profileGithubUsername}
              onChange={(e) => {
                setProfileGithubUsername(e.target.value);
                setProfileAvatarError(false);
              }}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Used to load your GitHub avatar on share cards. No @ prefix needed.
            </p>
          </div>

          <Button
            onClick={handleSaveProfile}
            disabled={!profileName.trim() || !profileNormalizedUsername}
          >
            Save Profile
          </Button>
        </CardContent>
      </Card>

      {/* Setup progress strip */}
      <div className="rounded-lg border bg-card px-4 py-3 flex items-center gap-4 flex-wrap">
        <span className="text-sm font-medium shrink-0">
          Setup: {requiredDone} of {requiredTotal} required configs complete
        </span>
        <div className="flex items-center gap-3 flex-wrap">
          {progressItems.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5 text-xs">
              {item.done ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Minus className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className={item.done ? 'text-foreground' : 'text-muted-foreground'}>
                {item.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <LlmProviderCard
        title="Background Analysis Provider"
        description="Configure the main LLM provider to analyze sessions and auto-generate insights in the background queue."
        icon={<Cpu className="h-5 w-5" />}
        config={{
          provider: llmConfig?.provider,
          model: llmConfig?.model,
          baseUrl: llmConfig?.baseUrl,
        }}
        onSave={async (config) => {
          await saveMutation.mutateAsync({
            provider: config.provider,
            model: config.model,
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
          });
        }}
      />

      <LlmProviderCard
        title="Interactive Knowledge Agent"
        description="Configure the LLM provider for the conversational RAG agent (Dashboard Chat)."
        icon={<Bot className="h-5 w-5" />}
        config={{
          provider: llmConfig?.agent?.provider,
          model: llmConfig?.agent?.model,
          baseUrl: llmConfig?.agent?.baseUrl,
        }}
        onSave={async (config) => {
          await saveMutation.mutateAsync({
            agent: config,
          });
        }}
        onClear={async () => {
          await saveMutation.mutateAsync({
            agent: {}, // Empty object will be treated as clear in our API handler
          });
        }}
      />

      <LlmProviderCard
        title="Embeddings Provider"
        description="Configure the model used for vector search and RAG distance metrics. Recommended: Ollama (nomic-embed-text) or OpenAI (text-embedding-3-small)."
        icon={<Database className="h-5 w-5" />}
        isEmbedding={true}
        config={{
          provider: llmConfig?.embedding?.provider,
          model: llmConfig?.embedding?.model,
          baseUrl: llmConfig?.embedding?.baseUrl,
        }}
        onSave={async (config) => {
          await saveMutation.mutateAsync({
            embedding: config,
          });
        }}
        onClear={async () => {
          await saveMutation.mutateAsync({
            embedding: {},
          });
        }}
      />

      {/* CLI Setup */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CLI Setup</CardTitle>
          <CardDescription>
            Install and configure the CLI to sync your AI coding sessions
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg bg-muted p-4 font-mono text-sm">
            <p className="text-muted-foreground"># Install the CLI</p>
            <p>npm install -g @code-insights/cli</p>
            <p className="mt-2 text-muted-foreground"># Initialize</p>
            <p>code-insights init</p>
            <p className="mt-2 text-muted-foreground"># Sync your sessions</p>
            <p>code-insights sync</p>
            <p className="mt-2 text-muted-foreground"># Open this dashboard</p>
            <p>code-insights dashboard</p>
          </div>
          <p className="text-sm text-muted-foreground">
            The CLI parses sessions from Claude Code, Cursor, Codex CLI, and Copilot CLI into a
            local SQLite database. All data stays on your machine.
          </p>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="text-center text-xs text-muted-foreground pt-2 pb-4">
        Code Insights &mdash;{' '}
        <a
          href="https://github.com/melagiri/code-insights"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground transition-colors"
        >
          View on GitHub
        </a>
      </div>
    </div>
  );
}
