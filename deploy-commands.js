require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("autostatus")
    .setDescription("Enable/disable automatic voice channel status updates")
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("on/off")
        .setRequired(true)
        .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })
    ),

  new SlashCommandBuilder()
    .setName("vcstatus")
    .setDescription("Set/clear the voice channel status manually")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set the voice channel status text (immediate)")
        .addStringOption((opt) =>
          opt.setName("text").setDescription("Status text (max 500 chars)").setRequired(true)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("lock")
            .setDescription("Turn AUTO OFF so the manual status sticks")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) => sub.setName("clear").setDescription("Clear stored manual status (and clear VC status)"))
    .addSubcommand((sub) => sub.setName("show").setDescription("Show current auto/manual state")),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log("✅ Commands registered.");
})();
