<base_verify>
The base commit fails verify in your sandbox. These tests fail on the base without this story's change, so their failures are not yours and need no baseline of your own:
- sandbox > a worker may not read the home directory
- worktree > setup copies the env file
</base_verify>
