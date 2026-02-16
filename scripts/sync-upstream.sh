#!/usr/bin/env bash
set -euo pipefail

# sync-upstream.sh - Sync Zocdoc fork with upstream anthropic-experimental/sandbox-runtime
# Usage: ./scripts/sync-upstream.sh

UPSTREAM_REMOTE="upstream"
UPSTREAM_URL="git@github.com:anthropic-experimental/sandbox-runtime.git"
ORIGIN_REMOTE="origin"
BRANCH_PREFIX="sync/upstream"
BASE_BRANCH="main"

echo "🔄 Starting upstream sync workflow..."

# Ensure we're in the repo root
if [ ! -d ".git" ]; then
    echo "❌ Error: Must run from repository root"
    exit 1
fi

# Ensure working directory is clean
if [ -n "$(git status --porcelain)" ]; then
    echo "❌ Error: Working directory is not clean"
    echo "   Please commit or stash your changes before running this script"
    git status --short
    exit 1
fi

# Ensure upstream remote exists
if ! git remote get-url "$UPSTREAM_REMOTE" &>/dev/null; then
    echo "📌 Adding upstream remote: $UPSTREAM_URL"
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

# Fetch both remotes
echo "📥 Fetching upstream and origin..."
git fetch "$UPSTREAM_REMOTE"
git fetch "$ORIGIN_REMOTE"

# Check if we're behind upstream
BEHIND_COUNT=$(git rev-list --count "${ORIGIN_REMOTE}/${BASE_BRANCH}..${UPSTREAM_REMOTE}/${BASE_BRANCH}" 2>/dev/null || echo "0")

if [ "$BEHIND_COUNT" -eq 0 ]; then
    echo "✅ Fork is up to date with upstream (0 commits behind)"
    exit 0
fi

echo "📊 Fork is $BEHIND_COUNT commit(s) behind upstream"

# Identify Zocdoc-only commits
echo "🔍 Identifying Zocdoc-only commits..."
ZOCDOC_COMMITS=$(git log --oneline --no-merges "${UPSTREAM_REMOTE}/${BASE_BRANCH}..${ORIGIN_REMOTE}/${BASE_BRANCH}" | tac)

if [ -z "$ZOCDOC_COMMITS" ]; then
    echo "ℹ️  No Zocdoc-specific commits found, fast-forwarding to upstream"
    git checkout "$BASE_BRANCH"
    git merge --ff-only "${UPSTREAM_REMOTE}/${BASE_BRANCH}"
    git push "$ORIGIN_REMOTE" "$BASE_BRANCH"
    echo "✅ Successfully fast-forwarded to upstream"
    exit 0
fi

echo "📝 Zocdoc commits to cherry-pick:"
echo "$ZOCDOC_COMMITS"

# Create sync branch
SYNC_BRANCH="${BRANCH_PREFIX}-$(date +%Y-%m-%d)"
echo "🌿 Creating sync branch: $SYNC_BRANCH"

if git show-ref --verify --quiet "refs/heads/$SYNC_BRANCH"; then
    echo "⚠️  Branch $SYNC_BRANCH already exists, using ${SYNC_BRANCH}-$(date +%H%M%S)"
    SYNC_BRANCH="${SYNC_BRANCH}-$(date +%H%M%S)"
fi

git checkout -b "$SYNC_BRANCH" "${UPSTREAM_REMOTE}/${BASE_BRANCH}"

# Cherry-pick each Zocdoc commit
echo "🍒 Cherry-picking Zocdoc commits..."
while IFS= read -r commit_line; do
    COMMIT_HASH=$(echo "$commit_line" | awk '{print $1}')
    COMMIT_MSG=$(echo "$commit_line" | cut -d' ' -f2-)

    echo "  → Cherry-picking: $COMMIT_MSG ($COMMIT_HASH)"

    if git cherry-pick "$COMMIT_HASH"; then
        echo "    ✓ Success"
    else
        echo "    ⚠️  Conflict detected, invoking Claude CLI to resolve..."

        # Get list of conflicted files
        CONFLICTED_FILES=$(git diff --name-only --diff-filter=U)

        if [ -z "$CONFLICTED_FILES" ]; then
            echo "    ❌ Cherry-pick failed but no conflicts found. Manual intervention required."
            exit 1
        fi

        echo "    Conflicted files:"
        echo "$CONFLICTED_FILES" | sed 's/^/      - /'

        # Invoke Claude CLI to resolve conflicts
        CLAUDE_PROMPT="I am syncing a Zocdoc fork with upstream anthropic-experimental/sandbox-runtime.

The following files have merge conflicts after cherry-picking commit $COMMIT_HASH:
$CONFLICTED_FILES

The commit being cherry-picked adds: $COMMIT_MSG

Please resolve the conflicts by:
1. Examining the conflicted files (they will have conflict markers)
2. Accepting upstream's structure and changes
3. Re-applying the Zocdoc feature (configurable clipboard/pasteboard access) on top of upstream's changes
4. Ensuring the resolution compiles by running: bun run build

After resolving, stage all files with: git add <files>

IMPORTANT: You must run 'bun run build' to verify the code compiles. If it doesn't compile, fix any TypeScript errors until it does."

        if claude --print "$CLAUDE_PROMPT"; then
            echo "    ✓ Claude resolved conflicts"

            # Verify all conflicts are resolved
            if git diff --name-only --diff-filter=U | grep -q .; then
                echo "    ❌ Not all conflicts were resolved. Manual intervention required."
                exit 1
            fi

            # Verify build succeeds
            echo "    🔨 Verifying build..."
            if ! bun run build; then
                echo "    ❌ Build failed after conflict resolution. Manual intervention required."
                exit 1
            fi

            echo "    ✓ Build successful"

            # Continue cherry-pick
            git cherry-pick --continue
            echo "    ✓ Cherry-pick completed"
        else
            echo "    ❌ Claude CLI failed to resolve conflicts. Manual intervention required."
            echo "    To continue manually:"
            echo "      1. Resolve conflicts in the files listed above"
            echo "      2. Run: git add <resolved-files>"
            echo "      3. Run: git cherry-pick --continue"
            echo "      4. Run: bun run build (to verify)"
            echo "      5. Re-run this script"
            exit 1
        fi
    fi
done <<< "$ZOCDOC_COMMITS"

echo "✅ All commits cherry-picked successfully"

# Push branch
echo "📤 Pushing sync branch to origin..."
git push -u "$ORIGIN_REMOTE" "$SYNC_BRANCH"

# Create PR
echo "🔀 Creating pull request..."
PR_BODY="## Upstream Sync

This PR syncs our fork with upstream \`anthropic-experimental/sandbox-runtime\`.

### Changes
- Rebased Zocdoc-specific commits on top of latest upstream
- Upstream commits: $BEHIND_COUNT
- Zocdoc commits preserved: $(echo "$ZOCDOC_COMMITS" | wc -l)

### Verification
- [x] Code compiles (\`bun run build\`)
- [ ] Tests pass (\`bun test\`)
- [ ] Zocdoc features still work (clipboard access)

### Zocdoc Commits
\`\`\`
$ZOCDOC_COMMITS
\`\`\`

---
Generated by \`scripts/sync-upstream.sh\`"

if gh pr create \
    --repo "Zocdoc/sandbox-runtime" \
    --title "Sync with upstream $(date +%Y-%m-%d)" \
    --body "$PR_BODY" \
    --base "$BASE_BRANCH" \
    --head "$SYNC_BRANCH"; then
    echo "✅ Pull request created successfully"
else
    echo "⚠️  Failed to create PR automatically. Please create manually:"
    echo "   Branch: $SYNC_BRANCH"
    echo "   Base: $BASE_BRANCH"
    exit 1
fi

echo ""
echo "🎉 Upstream sync complete!"
echo "   Review the PR and merge when ready."
