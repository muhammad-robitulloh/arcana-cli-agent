#!/usr/bin/env node

require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, Box, Text, Newline, useInput, useApp } = require('ink');

const CONFIG_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.arcanacli.json');

// --- Config File Management ---
function readConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    const configContent = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(configContent);
  }
  return {};
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function getConfigValue(key) {
  const config = readConfig();
  return config[key];
}

function setConfigValue(key, value) {
  const config = readConfig();
  config[key] = value;
  writeConfig(config);
}

function deleteConfigValue(key) {
  const config = readConfig();
  delete config[key];
  writeConfig(config);
}

// --- Load Configuration ---
let ARCANA_API_KEY = process.env.ARCANA_API_KEY || getConfigValue('api_key');
let VAREON_API_BASE_URL = process.env.VAREON_API_BASE_URL || getConfigValue('base_url') || 'http://localhost:8000/arcana';
let USER_ID = process.env.ARCANA_USER_ID || getConfigValue('user_id') || 'cli-user-123';

const api = axios.create({
  baseURL: VAREON_API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// --- Command Execution Logic (adapted for Ink) ---
async function executeCommand(command, args, verbose = false) {
  if (!ARCANA_API_KEY) {
    return {
      status: 'error',
      message: 'ARCANA_API_KEY is not set. Please set it via environment variable, .env file, or `arcana config set api_key <YOUR_KEY>`.' ,
      error: 'Authentication Error',
    };
  }

  if (verbose) {
    console.log(`[VERBOSE] Sending command: ${command}`);
    console.log(`[VERBOSE] Arguments: ${JSON.stringify(args)}`);
    console.log(`[VERBOSE] API Base URL: ${VAREON_API_BASE_URL}`);
    console.log(`[VERBOSE] User ID: ${USER_ID}`);
  }

  try {
    const response = await api.post('/cli/execute', {
      api_key: ARCANA_API_KEY,
      command: command,
      args: args,
      user_id: USER_ID,
    });

    if (verbose) {
      console.log(`[VERBOSE] API Response Status: ${response.status}`);
      console.log(`[VERBOSE] API Response Data: ${JSON.stringify(response.data, null, 2)}`);
    }

    return response.data;
  } catch (error) {
    if (verbose) {
      console.error('[VERBOSE] Full error object:', error);
    }
    let errorMessage = 'An unknown error occurred.';
    if (error.response) {
      errorMessage = error.response.data.detail || JSON.stringify(error.response.data);
    } else if (error.request) {
      errorMessage = 'Network Error: No response received from API. Check VAREON_API_BASE_URL.';
    } else {
      errorMessage = `Request Setup Error: ${error.message}`;
    }
    return {
      status: 'error',
      message: errorMessage,
      error: errorMessage,
    };
  }
}

// --- Ink App Component ---
function App() {
  const [input, setInput] = React.useState('');
  const [history, setHistory] = React.useState([]);
  const [currentDir, setCurrentDir] = React.useState(process.cwd());
  const [showErrorLogs, setShowErrorLogs] = React.useState(false); // State for error log visibility
  const [errorLogs, setErrorLogs] = React.useState([]); // State to store error logs
  const [activeJobs, setActiveJobs] = React.useState({}); // State to store active jobs for status display
  const [awaitingConfirmation, setAwaitingConfirmation] = React.useState(false);
  const [confirmationCallback, setConfirmationCallback] = React.useState(null);
  const { exit } = useApp();

  // Function to poll job status
  const pollJobStatus = React.useCallback(async (jobId) => {
    try {
      const response = await api.get(`/arcana/jobs/${jobId}/status`, {
        headers: { 'Authorization': `Bearer ${ARCANA_API_KEY}` }
      });
      const jobStatus = response.data;
      setActiveJobs((prevJobs) => {
        const updatedJobs = {
          ...prevJobs,
          [jobId]: { ...prevJobs[jobId], ...jobStatus },
        };
        if (jobStatus.status === 'completed' || jobStatus.status === 'failed') {
          // Stop polling for this job
          if (updatedJobs[jobId].intervalId) {
            clearInterval(updatedJobs[jobId].intervalId);
            delete updatedJobs[jobId].intervalId;
          }
          // Add final result to history
          setHistory((prev) => [
            ...prev,
            { type: jobStatus.status === 'completed' ? 'success' : 'error', value: `Job ${jobId} ${jobStatus.status}.` },
            { type: 'output', value: jobStatus.final_result || jobStatus.error || 'No output.' },
          ]);
        }
        return updatedJobs;
      });
    } catch (error) {
      console.error(`Error polling job ${jobId}:`, error);
      setErrorLogs((prev) => [...prev, `[${new Date().toISOString()}] Job Polling Error (${jobId}): ${error.message}`]);
      setActiveJobs((prevJobs) => {
        const updatedJobs = { ...prevJobs };
        if (updatedJobs[jobId] && updatedJobs[jobId].intervalId) {
          clearInterval(updatedJobs[jobId].intervalId);
          delete updatedJobs[jobId].intervalId;
        }
        return updatedJobs;
      });
    }
  }, []);

  // Effect to manage polling intervals
  React.useEffect(() => {
    // Cleanup intervals when component unmounts
    return () => {
      Object.values(activeJobs).forEach((job) => {
        if (job.intervalId) {
          clearInterval(job.intervalId);
        }
      });
    };
  }, [activeJobs]); // Re-run effect if activeJobs changes to clean up old intervals

  useInput((_input, key) => {
    if (awaitingConfirmation) {
      if (_input.toLowerCase() === 'y') {
        if (confirmationCallback) confirmationCallback(true);
      } else {
        if (confirmationCallback) confirmationCallback(false);
      }
      setAwaitingConfirmation(false);
      setConfirmationCallback(null);
      return;
    }

    if (key.return) {
      const commandLine = input.trim();
      if (commandLine === 'exit') {
        exit();
        return;
      }
      setHistory((prev) => [...prev, { type: 'input', value: commandLine }]);
      setInput('');
      processInteractiveCommand(commandLine);
    } else if (key.backspace || key.delete) {
      setInput(input.slice(0, -1));
    } else if (key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      // Ignore special keys for now
    } else if (key.ctrl && _input === 'o') { // Ctrl+O to toggle error logs
      setShowErrorLogs((prev) => !prev);
    } else {
      setInput(input + _input);
    }
  });

  const processInteractiveCommand = async (commandLine) => {
    const parts = commandLine.split(' ');
    const mainCommand = parts[0];
    const args = parts.slice(1);

    let result;

    if (mainCommand === 'cd') {
      const newPath = args[0];
      if (newPath) {
        try {
          process.chdir(newPath);
          setCurrentDir(process.cwd());
          result = { status: 'success', message: `Changed directory to ${process.cwd()}` };
        } catch (error) {
          result = { status: 'error', message: `Failed to change directory: ${error.message}` };
          setErrorLogs((prev) => [...prev, `[${new Date().toISOString()}] CD Error: ${error.message}`]);
        }
      } else {
        result = { status: 'error', message: 'Usage: cd <path>' };
      }
    } else if (mainCommand === '/model') {
      try {
        const modelResponse = await api.get('/cognisys/cli/model-details', {
          headers: { 'Authorization': `Bearer ${ARCANA_API_KEY}` } // Assuming API key is passed as Bearer token
        });
        result = {
          status: 'success',
          message: 'Model details retrieved.',
          output: JSON.stringify(modelResponse.data, null, 2),
        };
      } catch (error) {
        let errorMessage = 'Failed to fetch model details.';
        if (error.response) {
          errorMessage = error.response.data.detail || JSON.stringify(error.response.data);
        } else if (error.request) {
          errorMessage = 'Network Error: No response from API.';
        } else {
          errorMessage = `Request Setup Error: ${error.message}`;
        }
        result = { status: 'error', message: errorMessage, error: errorMessage };
        setErrorLogs((prev) => [...prev, `[${new Date().toISOString()}] Model Details Error: ${errorMessage}`]);
      }
    } else if (mainCommand === 'delete') {
      const filename = args[0];
      if (!filename) {
        result = { status: 'error', message: 'Usage: delete <filename>' };
      } else {
        setAwaitingConfirmation(true);
        setHistory((prev) => [...prev, { type: 'confirmation', value: `Are you sure you want to delete ${filename}? (y/n)` }]);
        setConfirmationCallback(() => async (confirmed) => {
          if (confirmed) {
            const deleteResult = await executeCommand('file-operation', ['delete', filename], false);
            setHistory((prev) => [...prev, { type: deleteResult.status, value: deleteResult.output || deleteResult.message }]);
            if (deleteResult.status === 'error') {
              setErrorLogs((prev) => [...prev, `[${new Date().toISOString()}] Delete Error: ${deleteResult.message}`]);
            }
          } else {
            setHistory((prev) => [...prev, { type: 'info', value: 'Delete operation cancelled.' }]);
          }
        });
        return; // Don't process further
      }
    } else {
      // For other commands, try to map them to executeCommand
      let mappedCommand = '';
      let mappedArgs = [];

      if (mainCommand === 'code' && args[0] === 'generate') {
        mappedCommand = 'generate-code';
        mappedArgs = args.slice(1);
      } else if (mainCommand === 'shell' && args[0] === 'translate') {
        mappedCommand = 'translate-shell';
        mappedArgs = args.slice(1);
      } else if (mainCommand === 'agent' && args[0] === 'run') {
        mappedCommand = 'agent-execute';
        mappedArgs = args.slice(1);
        result = await executeCommand(mappedCommand, mappedArgs, false);
        if (result.status === 'error') {
          setErrorLogs((prev) => [...prev, `[${new Date().toISOString()}] Command Error (${mappedCommand}): ${result.message}`]);
        } else if (result.job_id) {
          // Start polling for this job
          const intervalId = setInterval(() => pollJobStatus(result.job_id), 3000); // Poll every 3 seconds
          setActiveJobs((prevJobs) => ({
            ...prevJobs,
            [result.job_id]: {
              job_id: result.job_id,
              status: 'pending',
              output: result.output || 'Job initiated...',
              intervalId: intervalId,
            },
          }));
          setHistory((prev) => [...prev, { type: 'info', value: `Agent job ${result.job_id} initiated. Status updates will follow.` }]);
          return; // Don't add the initial result to history, as status updates will handle it
        }
      } else if (mainCommand === 'reason') {
        mappedCommand = 'reason';
        mappedArgs = args;
      } else if (mainCommand === 'file-operation') {
        mappedCommand = 'file-operation';
        mappedArgs = args;
      } else {
        result = { status: 'error', message: `Unknown command: ${commandLine}` };
      }

      if (mappedCommand) {
        result = await executeCommand(mappedCommand, mappedArgs, false); // verbose handled by Ink app if needed
        if (result.status === 'error') {
          setErrorLogs((prev) => [...prev, `[${new Date().toISOString()}] Command Error (${mappedCommand}): ${result.message}`]);
        }
      }
    }

    if (result) {
      setHistory((prev) => [...prev, { type: result.status, value: result.output || result.message }]);
    }
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green">Arcana CLI</Text>
        <Text color="gray"> - </Text>
        <Text color="cyan">{currentDir}</Text>
        <Text color="gray"> (Ctrl+O for logs)</Text>
      </Box>
      <Newline />
      <Box flexDirection="column">
        {history.map((item, i) => (
          <Text key={i} color={item.type === 'input' ? 'yellow' : (item.type === 'error' ? 'red' : 'white')}>
            {item.type === 'input' ? `> ${item.value}` : item.value}
          </Text>
        ))}
      </Box>
      {showErrorLogs && errorLogs.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="red" padding={1} marginTop={1}>
          <Text color="red">--- Error Logs (Ctrl+O to hide) ---</Text>
          {errorLogs.map((log, i) => (
            <Text key={`error-${i}`} color="red">{log}</Text>
          ))}
          <Text color="red">----------------------------------</Text>
        </Box>
      )}
      {Object.keys(activeJobs).length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="yellow" padding={1} marginTop={1}>
          <Text color="yellow">--- Active Jobs ---</Text>
          {Object.values(activeJobs).map((job) => (
            <Text key={job.job_id} color="yellow">
              Job {job.job_id}: Status - {job.status} {job.progress ? `(${job.progress}%)` : ''}
              {job.output && ` | Output: ${job.output.substring(0, 50)}...`}
            </Text>
          ))}
          <Text color="yellow">-------------------</Text>
        </Box>
      )}
      <Newline />
      <Box>
        <Text color="green">{'❯ '}</Text>
        <Text>{input}</Text>
      </Box>
    </Box>
  );
}

// --- Main CLI Logic ---
const cli = yargs(hideBin(process.argv))
  .command(
    'config <command>',
    'Manage local CLI configurations.',
    (yargs) => {
      yargs
        .command(
          'set <key> <value>',
          'Set a configuration value.',
          (yargs) => {
            yargs
              .positional('key', {
                describe: 'The configuration key (e.g., api_key, base_url, user_id).',
                type: 'string',
              })
              .positional('value', {
                describe: 'The value to set for the configuration key.',
                type: 'string',
              });
          },
          (argv) => {
            setConfigValue(argv.key, argv.value);
            console.log(`Configuration key '${argv.key}' set.`);
            process.exit(0);
          }
        )
        .command(
          'get <key>',
          'Get a configuration value.',
          (yargs) => {
            yargs.positional('key', {
              describe: 'The configuration key to retrieve.',
              type: 'string',
            });
          },
          (argv) => {
            const value = getConfigValue(argv.key);
            if (value !== undefined) {
              console.log(`${argv.key}: ${value}`);
            } else {
              console.log(`Configuration key '${argv.key}' not found.`);
            }
            process.exit(0);
          }
        )
        .command(
          'list',
          'List all stored configurations.',
          {},
          () => {
            const config = readConfig();
            if (Object.keys(config).length > 0) {
              console.log('Current CLI Configurations:');
              for (const key in config) {
                console.log(`  ${key}: ${key.includes('api_key') ? '****************' : config[key]}`); // Mask API key in list
              }
            } else {
              console.log('No CLI configurations found.');
            }
            process.exit(0);
          }
        )
        .command(
          'delete <key>',
          'Delete a configuration value.',
          (yargs) => {
            yargs.positional('key', {
              describe: 'The configuration key to delete.',
              type: 'string',
            });
          },
          (argv) => {
            deleteConfigValue(argv.key);
            console.log(`Configuration key '${argv.key}' deleted.`);
            process.exit(0);
          }
        )
        .demandCommand(1, 'Please specify a config command: set, get, list, or delete.');
    }
  )
  .command(
    'code <command>',
    'Commands related to code generation.',
    (yargs) => {
      yargs.command(
        'generate <prompt>',
        'Generates code based on a natural language prompt.',
        (yargs) => {
          yargs.positional('prompt', {
            describe: 'The natural language prompt for code generation.',
            type: 'string',
          });
        },
        async (argv) => {
          const result = await executeCommand('generate-code', [argv.prompt], argv.verbose);
          if (result.status === 'error') {
            console.error('Error:', result.message);
            if (result.error) console.error('Details:', result.error);
            process.exit(1);
          } else {
            console.log('Success:', result.message);
            if (result.output) {
              console.log('\n--- Generated Code ---');
              console.log(result.output);
              console.log('----------------------\n');
            }
            process.exit(0);
          }
        }
      ).demandCommand(1, 'Please specify a code command: generate.');
    }
  )
  .command(
    'shell <command>',
    'Commands related to shell command translation.',
    (yargs) => {
      yargs.command(
        'translate <instruction>',
        'Translates a natural language instruction into a shell command.',
        (yargs) => {
          yargs.positional('instruction', {
            describe: 'The natural language instruction for shell command translation.',
            type: 'string',
          });
        },
        async (argv) => {
          const result = await executeCommand('translate-shell', [argv.instruction], argv.verbose);
          if (result.status === 'error') {
            console.error('Error:', result.message);
            if (result.error) console.error('Details:', result.error);
            process.exit(1);
          } else {
            console.log('Success:', result.message);
            if (result.output) console.log(result.output);
            process.exit(0);
          }
        }
      ).demandCommand(1, 'Please specify a shell command: translate.');
    }
  )
  .command(
    'agent <command>',
    'Commands related to Arcana Agents.',
    (yargs) => {
      yargs.command(
        'run <agent_id> <task_prompt>',
        'Executes a task for a specific Arcana Agent.',
        (yargs) => {
          yargs
            .positional('agent_id', {
              describe: 'The ID of the Arcana Agent to execute the task.',
              type: 'string',
            })
            .positional('task_prompt', {
              describe: 'The prompt for the task to be executed by the agent.',
              type: 'string',
            });
        },
        async (argv) => {
          const result = await executeCommand('agent-execute', [argv.agent_id, argv.task_prompt], argv.verbose);
          if (result.status === 'error') {
            console.error('Error:', result.message);
            if (result.error) console.error('Details:', result.error);
            process.exit(1);
          } else {
            console.log('Success:', result.message);
            if (result.output) console.log(result.output);
            process.exit(0);
          }
        }
      ).demandCommand(1, 'Please specify an agent command: run.');
    }
  )
  .command(
    'reason <prompt>',
    'Generates a detailed reasoning trace for a given task.',
    (yargs) => {
      yargs.positional('prompt', {
        describe: 'The natural language prompt for reasoning generation.',
        type: 'string',
      });
    },
    async (argv) => {
      const result = await executeCommand('reason', [argv.prompt], argv.verbose);
      if (result.status === 'error') {
        console.error('Error:', result.message);
        if (result.error) console.error('Details:', result.error);
        process.exit(1);
      } else {
        console.log('Success:', result.message);
        if (result.output) {
          console.log('\n--- Reasoning Trace ---');
          console.log(result.output);
          console.log('-----------------------\n');
        }
        process.exit(0);
      }
    }
  )
  .command(
    'file-operation <operation> <path> [content]',
    'Performs various file operations (e.g., read, write, delete).',
    (yargs) => {
      yargs
        .positional('operation', {
          describe: 'The file operation to perform (e.g., "read", "write", "delete").',
          type: 'string',
        })
        .positional('path', {
          describe: 'The path to the file.',
          type: 'string',
        })
        .positional('content', {
          describe: 'Content for "write" operation (optional).',
          type: 'string',
        });
    },
    async (argv) => {
      const args = [argv.operation, argv.path];
      if (argv.content) {
        args.push(argv.content);
      }
      const result = await executeCommand('file-operation', args, argv.verbose);
      if (result.status === 'error') {
        console.error('Error:', result.message);
        if (result.error) console.error('Details:', result.error);
        process.exit(1);
      } else {
        console.log('Success:', result.message);
        if (result.output) console.log(result.output);
        process.exit(0);
      }
    }
  )
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Run with verbose logging',
  })
  .help()
  .alias('h', 'help')
  .version(async () => {
    const cliVersion = require('./package.json').version;
    let backendVersion = 'N/A';
    try {
      const response = await api.get('/version');
      backendVersion = response.data.version;
    } catch (error) {
      console.error('Warning: Could not fetch backend version.');
    }
    return `Arcana CLI Version: ${cliVersion}\nArcana Backend Version: ${backendVersion}`;
  })
  .alias('V', 'version') // Changed alias to 'V' to avoid conflict with verbose 'v'
  .parse(); // Use .parse() to ensure commands are processed

// If no command was handled by yargs, render the Ink app
if (cli.argv._.length === 0 && !cli.argv.help && !cli.argv.version) {
  render(<App />);
}