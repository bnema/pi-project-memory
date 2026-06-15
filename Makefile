PROJECT_MEMORY_ROOT ?= $(HOME)/.pi/agent/project-memory

.PHONY: clear-memory
clear-memory:
	@rm -rf "$(PROJECT_MEMORY_ROOT)"
	@mkdir -p "$(PROJECT_MEMORY_ROOT)"
	@chmod 700 "$(PROJECT_MEMORY_ROOT)"
	@printf 'Cleared project memory at %s\n' "$(PROJECT_MEMORY_ROOT)"
