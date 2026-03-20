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

  new SlashCommandBuilder()
    .setName("gif")
    .setDescription("GIF commands - upload and get random GIFs")
    .addSubcommand((sub) =>
      sub
        .setName("upload")
        .setDescription("Upload a GIF/image to the CDN (requires upload role)")
        .addAttachmentOption((opt) =>
          opt.setName("file").setDescription("Image to upload (.gif, .png, .jpg, .webp — non-GIFs are converted)").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("name").setDescription("Display name for the GIF").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("random")
        .setDescription("Get a random GIF")
        .addStringOption((opt) =>
          opt.setName("tags").setDescription("Only show GIFs with these tags (comma-separated)").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("exclude").setDescription("Additional tags to exclude (comma-separated)").setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt.setName("hidden").setDescription("Only show the result to you").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("tags")
        .setDescription("Show all available tags with usage counts")
    )
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add tag(s) to exclude in this channel")
        .addStringOption((opt) =>
          opt.setName("tags").setDescription("Tag(s) to exclude (comma-separated for multiple)").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove tag(s) from this channel's exclusion list")
        .addStringOption((opt) =>
          opt.setName("tags").setDescription("Tag(s) to remove (comma-separated for multiple)").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List excluded tags for this channel")
    )
    .addSubcommand((sub) =>
      sub
        .setName("clear")
        .setDescription("Clear all excluded tags for this channel")
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log("✅ Commands registered.");
})();
